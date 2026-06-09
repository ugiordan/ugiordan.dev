---
title: 'Protect your Kubernetes Operator from OOMKill'
description: 'How an unfiltered informer cache lets any user with edit permissions crash your operator. I found this in the Spark Operator, but the pattern is everywhere.'
pubDate: 'Jun 01 2026'
---

I was auditing the Kubeflow Spark Operator when I noticed something odd in its cache configuration. Pods had a label selector filtering what the informer caches. ConfigMaps had an empty `{}`. That empty config means the informer caches every single ConfigMap in every namespace, cluster-wide, in memory.

That's a problem. A big one.

## How informer caches work

If you write Kubernetes operators with controller-runtime, you already know the basics, but the details matter here.

When your operator needs to know about objects in the cluster (Pods, ConfigMaps, Secrets), it doesn't query the API server every time. That would be slow and create too much load. Instead, it sets up an **informer**: a component that does a full `LIST` of every matching object at startup, then opens a persistent `WATCH` connection to receive changes in real time.

Every object the informer sees gets deserialized into a full Go struct and stored in an in-memory cache. Subsequent `client.Get()` calls read from this cache instead of hitting the API server. Fast and efficient.

The problem is the word "every." If you set up an informer without filters, it caches every single object of that type. Every ConfigMap. Every Secret. Every namespace. All in memory.

## The vulnerable code

Here's what the Spark Operator's cache configuration looked like:

```go
ByObject: map[client.Object]cache.ByObject{
    &corev1.Pod{}: {
        Label: labels.SelectorFromSet(labels.Set{
            "sparkoperator.k8s.io/launched-by-spark-operator": "true",
        }),
    },
    &corev1.ConfigMap{}: {},  // caches ALL ConfigMaps everywhere
}
```

Pods are filtered. Only pods with the Spark operator label get cached. That's correct.

ConfigMaps have an empty `{}`. No label selector, no namespace filter, no field selector. The informer watches and caches every ConfigMap in the entire cluster.

## How any user can exploit this

No special permissions are needed. Any user with the standard `edit` ClusterRole, which is the default for developers and data scientists in multi-tenant clusters, can create ConfigMaps. Each ConfigMap can be up to 1MB.

The attack is straightforward. Generate a 900KB payload:

```bash
dd if=/dev/urandom bs=1024 count=900 2>/dev/null | base64 > /tmp/payload.txt
truncate -s 921600 /tmp/payload.txt
```

Create 10 test namespaces and flood them with 700 ConfigMaps:

```bash
for i in $(seq 1 10); do
  oc create ns oom-test-$i
done

for i in $(seq 1 700); do
  ns="oom-test-$(( (i % 10) + 1 ))"
  oc create configmap "oom-payload-$i" \
    --from-file=data=/tmp/payload.txt -n "$ns" 2>/dev/null &
  [ $((i % 5)) -eq 0 ] && wait
done
wait
```

The math: 700 ConfigMaps at 900KB each is about 630MB of raw data. But the informer doesn't store raw bytes. It deserializes each ConfigMap into a typed Go struct with map headers, string headers, and pointer indirection. Actual memory consumption exceeds the raw payload size significantly.

With a typical 512 MiB memory limit, the operator gets OOMKilled. It restarts, does a full re-LIST (which pulls all 700 ConfigMaps back into memory), crashes again, and enters `CrashLoopBackOff`. Complete denial-of-service.

Within 30-60 seconds of the flood:

```
spark-operator-controller-bb745cb-qj6vj   0/1   OOMKilled          5   16h
spark-operator-controller-bb745cb-qj6vj   0/1   CrashLoopBackOff   5   16h
```

And OOMKill is actually the **visible** failure mode. On clusters where the operator has a higher memory limit, the informer survives but the `LIST` response can grow large enough to break HTTP/2 streams on the API server connection. This poisons the shared connection pool, causing subsequent API calls to hang indefinitely. The operator pod stays Running with zero restarts, looks healthy from the outside, but one or more controllers are silently deadlocked. I've seen this cause an authentication controller to hang for nearly 2 hours on a production cluster before anyone noticed.

## Things that look like they protect you but don't

This is where experienced Go developers get tripped up.

### Predicates and event filters

You might think you're safe if you have a predicate filtering events:

```go
builder.Watches(&corev1.ConfigMap{},
    handler.EnqueueRequestsFromMapFunc(mapToOwner),
    builder.WithPredicates(predicate.NewPredicateFuncs(
        func(obj client.Object) bool {
            return obj.GetName() == "my-operator-config"
        },
    )),
)
```

The predicate does filter events. Only events for `my-operator-config` will trigger your reconciler. But the predicate sits between the informer and the work queue. The informer itself still does a full `LIST+WATCH` on every ConfigMap in every namespace, deserializes each one into a `corev1.ConfigMap` struct, and holds them all in memory.

Your memory footprint is determined by what the informer watches, not by what your predicates let through to the reconciler.

### DisableFor on the client

controller-runtime's client has a `DisableFor` option that looks like it turns off caching:

```go
mgr, err := ctrl.NewManager(cfg, ctrl.Options{
    Client: client.Options{
        Cache: &client.CacheOptions{
            DisableFor: []client.Object{
                &corev1.ConfigMap{},
            },
        },
    },
})
```

For `client.Get()` and `client.List()` calls, this works: they bypass the cache and go straight to the API server. But if your controller setup also includes `Owns(&corev1.ConfigMap{})` or `Watches(&corev1.ConfigMap{}, ...)`, those create a completely independent informer through the controller builder. `DisableFor` has zero effect on controller builder informers. They're separate code paths.

## The fix

Four steps. Each one matters.

### Step 1: Filter the cache

Add a label selector to restrict what the informer caches:

```go
// Before (vulnerable):
&corev1.ConfigMap{}: {},

// After (fixed):
&corev1.ConfigMap{}: {
    Label: labels.SelectorFromSet(labels.Set{
        "sparkoperator.k8s.io/created-by-spark-operator": "true",
    }),
},
```

Now the informer only caches ConfigMaps with that label. Everything else is ignored.

### Step 2: Label your own ConfigMaps

Since the cache now filters by label, every ConfigMap your operator creates must carry the label:

```go
return &corev1.ConfigMap{
    ObjectMeta: metav1.ObjectMeta{
        Name:      prometheusConfigMapName,
        Namespace: app.Namespace,
        Labels: map[string]string{
            "sparkoperator.k8s.io/created-by-spark-operator": "true",
        },
    },
    Data: configMapData,
}
```

### Step 3: Handle the upgrade path

This is the step most people forget. Pre-existing ConfigMaps from the old operator version don't have the label. After the upgrade, the filtered cache can't see them. So `client.Get()` returns `NotFound` (cache can't see the unlabeled object), but `client.Create()` returns `AlreadyExists` (object exists in the API server).

The fix uses a **merge patch**, which doesn't require a `resourceVersion`:

```go
if errors.IsAlreadyExists(createErr) {
    base := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      configMap.Name,
            Namespace: configMap.Namespace,
        },
    }
    desired := base.DeepCopy()
    desired.Labels = map[string]string{
        "sparkoperator.k8s.io/created-by-spark-operator": "true",
    }
    desired.Data = configMap.Data
    return c.Patch(ctx, desired, client.MergeFrom(base))
}
```

The merge patch adds the label and updates the data in one operation. Once the label is applied, the filtered cache picks up the ConfigMap and subsequent `client.Get()` calls work normally.

### Step 4: Propagate labels during updates

Make sure the label persists when your operator updates ConfigMaps:

```go
cm.Data = configMap.Data
if cm.Labels == nil {
    cm.Labels = map[string]string{}
}
cm.Labels["sparkoperator.k8s.io/created-by-spark-operator"] = "true"
return c.Update(ctx, cm)
```

## Results on a real cluster

I validated both the vulnerability and the fix on an OpenShift cluster. The test keeps the 700 flooded ConfigMaps in place between phases, so the patched operator has to survive the same hostile environment.

| Metric | Unpatched | Patched |
|--------|-----------|---------|
| Status | OOMKilled, CrashLoopBackOff | Running, 0 restarts |
| Memory | Exceeded 512 MiB (exit 137) | 14 MiB, flat |
| 700 flooded ConfigMaps | All cached | Ignored |

The patched operator starts up, does its filtered LIST (which returns zero results because none of the flood ConfigMaps have the operator label), and settles at 14 MiB. The 700 hostile ConfigMaps are completely invisible to it.

## This is not just the Spark Operator

When I audited other controller-runtime operators for the same pattern, I found it in the majority of them. Not just with ConfigMaps, but with Secrets, Services, and other high-volume resource types. The Kubeflow Training Operator was independently reported by another engineer for the same issue ([kubeflow/trainer#3374](https://github.com/kubeflow/trainer/issues/3374)), confirming this is systemic.

The root cause is a bad default: `ByObject` caches everything when no selector is specified. An empty `{}` looks harmless but creates a cluster-wide informer. Every controller-runtime operator should audit its cache configuration for unfiltered entries.

The upstream fix for the Spark Operator is at [kubeflow/spark-operator#2878](https://github.com/kubeflow/spark-operator/pull/2878). The full article with detailed reproduction steps is on [Red Hat Developer](https://developers.redhat.com/articles/2026/06/01/protect-your-kubernetes-operator-oomkill).

I'm writing a follow-up post covering 5 anti-patterns that cause this vulnerability, including code paths that are completely invisible during code review, like `client.Get()` silently creating cluster-wide informers. Stay tuned.
