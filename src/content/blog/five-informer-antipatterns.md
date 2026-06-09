---
title: 'Why your operator caches everything in the cluster (5 anti-patterns)'
description: 'The Spark Operator OOMKill was not unique. Here are 5 anti-patterns that cause unfiltered informer caches in controller-runtime operators, including code paths invisible during review.'
pubDate: 'Jun 09 2026'
draft: true
---

In the [previous post](/blog/protect-operator-from-oomkill/), I showed how an unfiltered ConfigMap cache took down the Kubeflow Spark Operator. We fixed that one and moved on. Then we audited other controller-runtime operators and found the same pattern in the majority of them. Not just ConfigMaps: Secrets, Services, and other high-volume resource types. The Kubeflow Training Operator was independently reported by another engineer for the same issue ([kubeflow/trainer#3374](https://github.com/kubeflow/trainer/issues/3374)), confirming this is systemic.

This post catalogs the 5 anti-patterns that cause the vulnerability, explains why each one fools experienced Go developers into thinking they're protected, and provides fixes. Everything here applies equally to Secrets, which are typically more numerous on production clusters (ServiceAccount tokens, TLS certs, registry auth).

## Quick recap: informer caches

When a controller-runtime operator needs to know about objects in the cluster, it sets up an informer: a full `LIST` of every matching object at startup, then a persistent `WATCH` connection for changes. Every object gets deserialized into a full Go struct and stored in memory.

No filters means every object of that type, across every namespace, in memory. A user with the standard `edit` ClusterRole can create ConfigMaps up to 1MB each. 700 of them is enough to OOMKill most operators.

And OOMKill is actually the visible failure. On clusters where the operator has a higher memory limit, the `LIST` response can grow large enough to break HTTP/2 streams on the API server connection. This poisons the shared connection pool, causing subsequent API calls to hang indefinitely. The operator pod stays Running with zero restarts, looks healthy from the outside, but one or more controllers are silently deadlocked. This happened on a production cluster where an unfiltered ConfigMap informer caused the authentication controller to hang for nearly 2 hours before anyone noticed.

## Anti-pattern 1: "My predicate filters it, so I'm safe"

The most common misunderstanding. You write:

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

The intent: only watch a single ConfigMap named `my-operator-config`. The predicate filters everything else out. And it does, at reconciliation time. Events for other ConfigMaps won't trigger your reconciler.

But the informer doesn't know about your predicate. The predicate sits between the informer and the work queue. The informer still does a full `LIST+WATCH` on every ConfigMap in every namespace, deserializes each one, and holds them all in memory.

`WithEventFilter()` has the same limitation. It's a reconciliation-time gate, not a cache-time gate. Your memory footprint is determined by what the informer watches, not by what your predicates let through.

**The fix:** If you only need to read a specific ConfigMap occasionally (like a CA bundle), don't use `Watches()` at all. Use a direct API call through an uncached client:

```go
apiReader := mgr.GetAPIReader()

var caCM corev1.ConfigMap
if err := apiReader.Get(ctx, client.ObjectKey{
    Namespace: "openshift-config-managed",
    Name:      "default-ingress-cert",
}, &caCM); err != nil {
    return err
}
```

No informer, no cache, no memory growth. The tradeoff is latency (~50ms per API call vs ~1ms from cache), which is acceptable for resources you read once during reconciliation.

## Anti-pattern 2: "I used DisableFor, so caching is off"

controller-runtime's client has a `DisableFor` option:

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

For `client.Get()` and `client.List()` calls, this works: those bypass the cache and go straight to the API server.

But there's a separate code path. When your controller setup includes:

```go
func (r *MyReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&myv1.MyResource{}).
        Owns(&corev1.ConfigMap{}).   // creates an informer
        Watches(&corev1.Secret{}, ...). // also creates an informer
        Complete(r)
}
```

`Owns()` registers a ConfigMap informer through the controller builder. This is a completely independent code path from the client cache. The informer starts, watches every ConfigMap cluster-wide, and caches all of them. `DisableFor` has zero effect on it.

**The fix:** If you own ConfigMaps and need to reconcile when they change, keep `Owns()` but add a label selector to the `ByObject` cache config. If you're using `Owns()` just for garbage collection, owner references handle that automatically without informers.

## Anti-pattern 3: The invisible informer from client.Get()

This is the most dangerous one because it's completely invisible during code review. No `Watches()`, no `Owns()`, just a regular `client.Get()`:

```go
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var cm corev1.ConfigMap
    if err := r.Client.Get(ctx, client.ObjectKey{
        Namespace: req.Namespace,
        Name:      "some-config",
    }, &cm); err != nil {
        return ctrl.Result{}, err
    }
}
```

If ConfigMap is not listed in your `cache.Options.ByObject`, here's what happens the first time this runs:

1. `r.Client.Get()` routes to the cached client (the default)
2. The cache doesn't have an informer for ConfigMap yet
3. controller-runtime creates a new cluster-wide ConfigMap informer on the fly
4. The informer does a full `LIST` of every ConfigMap in every namespace
5. All of them get deserialized and cached in memory
6. Your `Get()` returns the one ConfigMap you asked for

Steps 2 through 5 happen silently, once, on the first access. You never asked for a cluster-wide informer, but you got one.

We found one operator that had label selectors on 9 resource types in its `ByObject` config (Deployments, ConfigMaps, PVCs, ServiceAccounts, Services, NetworkPolicies, ClusterRoleBindings, RoleBindings, Roles) but omitted Secrets. A single `client.Get()` for a Secret triggered this exact anti-pattern: an implicit unfiltered cluster-wide Secret informer.

**The fix:** Add the type to `DisableFor`:

```go
Client: client.Options{
    Cache: &client.CacheOptions{
        DisableFor: []client.Object{
            &corev1.ConfigMap{},
            &corev1.Secret{},
        },
    },
},
```

Any `client.Get()` or `client.List()` for these types now goes directly to the API server. No implicit informer gets created.

## Anti-pattern 4: Everything is cluster-wide by default

controller-runtime's cache has a `DefaultNamespaces` option:

```go
Cache: cache.Options{
    DefaultNamespaces: map[string]cache.Config{
        "my-operator-ns": {},
    },
}
```

When set, informers only watch the listed namespaces. When not set (the default), every informer watches all namespaces.

Most operators can't simply restrict to a single namespace because they manage resources across user namespaces. But the awareness matters: if your operator creates resources in 5 namespaces, and you don't set `DefaultNamespaces` or per-resource label selectors, your ConfigMap informer watches ConfigMaps in all 500 namespaces on the cluster.

For multi-namespace operators, label selectors are usually the right fix. For single-namespace operators, `DefaultNamespaces` is the simplest protection.

## Anti-pattern 5: The typed/unstructured cache trap

controller-runtime maintains three completely separate caches:

- **Typed cache**: full Go structs (`corev1.ConfigMap`, `corev1.Pod`)
- **Unstructured cache**: `map[string]interface{}` representations
- **Partial/Metadata cache**: only `ObjectMeta` (name, namespace, labels)

These caches don't share entries. A ConfigMap cached as a typed `corev1.ConfigMap` is invisible to a `client.Get()` that requests an `unstructured.Unstructured`.

If your controller uses `Watches(&corev1.ConfigMap{})` for reconciliation events but reads ConfigMaps in your reconciler using an unstructured `Get`, the typed cache pays the full memory cost of caching every matching ConfigMap, but none of those cached objects ever serve a read.

**The fix:** Make sure your read path and your watch path use the same object representation. If you watch typed, read typed. If you need unstructured reads, consider whether you need the watch at all.

## Audit checklist

Before you ship an operator, check these:

1. **Every `ByObject` entry with `{}`** is an unfiltered cluster-wide informer. Add label selectors.
2. **Every `Watches()` and `Owns()` call** creates an informer. Make sure the referenced type has cache filtering.
3. **Every `client.Get()` for a core type** (ConfigMap, Secret, Service) either needs `ByObject` filtering or `DisableFor`.
4. **Predicates and event filters** don't protect memory. They only filter the work queue.
5. **`DisableFor`** doesn't affect controller builder informers (`Owns`, `Watches`, `For`).

The pattern is systemic because `ByObject` defaults to "cache everything" when no selector is specified. Audit your operators.

*This is a companion to the [Red Hat Developer article](https://developers.redhat.com/articles/2026/06/01/protect-your-kubernetes-operator-oomkill) on the original Spark Operator vulnerability and fix.*
