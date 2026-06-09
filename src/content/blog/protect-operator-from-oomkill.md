---
title: 'Protect your Kubernetes Operator from OOMKill'
description: 'How an unfiltered informer cache lets any edit user crash your operator with 700 ConfigMaps. We found this in the Spark Operator and fixed it upstream.'
pubDate: 'Jun 01 2026'
---

I co-authored an article on Red Hat Developer about a vulnerability pattern we found in the Kubeflow Spark Operator: an unfiltered informer cache that lets any user with standard `edit` permissions crash the operator by flooding the cluster with large ConfigMaps.

The full article is on [Red Hat Developer](https://developers.redhat.com/articles/2026/06/01/protect-your-kubernetes-operator-oomkill). Here I'll give the condensed version and explain why this matters beyond the Spark Operator.

## The problem

Kubernetes operators use informers to watch cluster resources. An informer does a full `LIST` at startup, then maintains a `WATCH` connection for real-time updates. Every object gets deserialized into a Go struct and stored in memory.

The Spark Operator's cache configuration looked like this:

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

Pods were filtered by label. ConfigMaps had an empty `{}`, meaning the informer caches every ConfigMap in every namespace cluster-wide.

## The exploit

No special permissions needed. Any user with the standard `edit` ClusterRole (granted to developers and data scientists in multi-tenant clusters) can create ConfigMaps up to 1MB each.

The math: 700 ConfigMaps at 900KB each is about 630MB of raw data. After Go struct overhead (map headers, string headers, pointer indirection), actual memory consumption exceeds the raw size. With a typical 512 MiB limit, the operator gets OOMKilled, restarts, re-lists everything, crashes again, and enters `CrashLoopBackOff`.

Total denial-of-service. No special tools required.

## Common misconceptions

Two things that look like they protect you but don't:

**Predicates and event filters** only control which events trigger reconciliation. The underlying informer still deserializes and caches every object. Your predicate sits between the informer and the work queue. It has no effect on memory.

**`DisableFor` on the client** only bypasses cache reads. If you also use `Owns()` or `Watches()` in your controller builder for the same type, those create a completely independent informer that `DisableFor` doesn't touch.

## The fix

Four steps, covered in detail in the [full article](https://developers.redhat.com/articles/2026/06/01/protect-your-kubernetes-operator-oomkill):

1. **Filter the cache** with label selectors on `ByObject`
2. **Label your own resources** so the filtered cache can see them
3. **Handle the upgrade path** for pre-existing unlabeled resources using merge patches
4. **Propagate labels** during updates

The upstream fix is at [kubeflow/spark-operator#2878](https://github.com/kubeflow/spark-operator/pull/2878).

## Why this matters

The Spark Operator was not unique. When we audited other controller-runtime operators for the same pattern, we found it in the majority of them. Not just with ConfigMaps, but with Secrets, Services, and other high-volume resource types. The `ByObject` default of "cache everything when no selector is specified" is a systemic issue across the controller-runtime ecosystem.

I wrote a follow-up article cataloging the 5 anti-patterns that cause this vulnerability, including code paths that are completely invisible during code review (like `client.Get()` silently creating cluster-wide informers). That one is coming soon.

## Proving it on a real cluster

We validated both the vulnerability and the fix on an OpenShift cluster. The test is straightforward: deploy the unpatched operator, flood 700 ConfigMaps across 10 namespaces, watch the operator crash. Then deploy the patched operator with the same 700 ConfigMaps still in place and confirm it runs at 14 MiB with zero restarts.

| Metric | Unpatched | Patched |
|--------|-----------|---------|
| Status | OOMKilled, CrashLoopBackOff | Running, 0 restarts |
| Memory | Exceeded 512 MiB (exit 137) | 14 MiB, flat |
| 700 flooded ConfigMaps | All cached | Ignored |

The full reproduction steps are in the [article](https://developers.redhat.com/articles/2026/06/01/protect-your-kubernetes-operator-oomkill).
