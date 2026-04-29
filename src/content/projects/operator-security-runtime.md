---
title: operator-security-runtime
description: Found a CVSS 9.1 privilege escalation across RHOAI operators. Built a Go library that replaces cluster-wide permissions with per-namespace scoped Roles, validated with a 200-trial performance framework.
tags: [Go, Kubernetes, Security]
category: Security & Platform
featured: true
order: 1
links: []
visibility: private
---

Defense-in-depth Go library that replaces cluster-wide ClusterRoles with per-namespace scoped Roles. Addresses a CVSS 9.1 privilege escalation found across RHOAI operators. Includes bind mode, ValidatingAdmissionPolicies, and a 200-trial performance validation framework with Wilcoxon rank-sum analysis.
