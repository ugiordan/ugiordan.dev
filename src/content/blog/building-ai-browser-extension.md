---
title: 'Building an AI-powered browser extension for tab lifecycle management'
description: 'How I built a Chrome extension with a skill-based AI integration that lets any AI agent manage browser tabs through natural language, using a bridge REST API and curl commands.'
pubDate: 'May 07 2026'
---

I have a tab problem. Not the "20 tabs" kind. The "80 tabs across 3 windows and I lost that one page I was reading yesterday" kind. Tabs serve as reminders, reading queues and status dashboards all at once, and none of those jobs get done well when they're buried in a sea of other tabs.

So I built a system to fix it: a Chrome extension that manages tabs through lifecycle states, a local bridge server that persists state to disk and a Claude skill that lets any AI agent manage my tabs through natural language using plain curl commands.

If you've ever wanted to connect a browser extension to an AI agent, or you're curious about how skill-based AI integrations work in practice, this post walks through the architecture, the tricky parts and what I'd do differently.

The project is called [Tab Lifecycle Manager](https://github.com/ugiordan/tab-manager) and it ships as a monorepo with two packages.

## The core idea: tab lifecycle states

Instead of tabs just being "open" or "closed," the extension manages three lifecycle states for tabs that aren't actively open:

- **Snoozed**: tab is closed but remembered, reopens at a scheduled time via Chrome Alarms
- **Queued**: tab is saved in an ordered list, pulled manually when you're ready
- **Watching**: tab is closed, a CSS selector is polled for content changes

Active tabs are normal Chrome tabs. The lifecycle system manages the transitions: snoozing an active tab closes it and schedules a wake-up, queuing saves it to an ordered list and watching sets up periodic polling on a specific page element.

This maps to how I actually think about tabs. Some I need now. Some I want to read later. Some I'm waiting on, like a CI pipeline, a PR review or a deploy status page.

## Architecture

The system has three components:

```
AI Agent --curl/HTTP--> Bridge Server <--WebSocket--> Chrome Extension
```

The **Chrome extension** owns all live state. It stores everything in Chrome Storage and is the single source of truth for active tabs and in-browser lifecycle operations (alarms, polling, tab creation).

The **bridge server** is a Node.js Express app that maintains its own copy of lifecycle state in JSON files at `~/.tab-manager/`. The bridge also maintains a WebSocket connection to the extension for two purposes: pushing commands (wake, meeting-start, meeting-end) and receiving state sync updates.

The **Claude skill** is a set of instructions and curl commands that any AI agent reads and executes directly. The agent reads the skill file (`SKILL.md`), understands the available operations and calls the bridge's REST API via curl. No SDK, no protocol layer, no runtime dependency. Just HTTP.

This layered approach means the extension works fully standalone without the bridge or the skill. The bridge adds persistence and API access. The skill adds AI integration on top.

## The monorepo setup

```
tab-manager/
  packages/
    extension/    # Chrome extension (React 18, PatternFly 5, Manifest V3)
    bridge/       # Node.js bridge server (Express, WebSocket)
  package.json    # npm workspaces
```

Both packages share TypeScript and Zod schemas for the tab data model. npm workspaces handles dependency management across the monorepo. Each package builds independently but they share types through workspace references.

## The skill-based AI integration

Instead of building a protocol-specific plugin, the AI integration is a plain markdown file (`.claude/skills/managing-tabs/SKILL.md`) that teaches the agent how to call the bridge REST API. The agent reads the instructions, then uses curl to perform operations. Here's what a snooze operation looks like:

```bash
curl -s -X POST http://localhost:19876/lifecycle/snooze \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "title": "Example", "wakeAt": 1712345678000}'
```

No SDK installation, no type bindings, no transport configuration. The agent calculates `wakeAt` from user intent (e.g., "snooze for 2 hours" becomes `current_time_ms + 120 * 60000`) and fires the request.

The skill file also defines workflows for common multi-step tasks. For example, the "clean up stale tabs" workflow tells the agent to fetch active tabs, analyze idle times, suggest candidates for snooze or queue, then execute the user's choices. The agent handles the logic; the skill just provides the API surface and the patterns.

This approach has a key advantage: it's agent-agnostic. Any AI agent that can read instructions and execute curl commands can use it. There's no coupling to a specific protocol or SDK version.

The full set of operations:

| Operation | What it does |
|-----------|-------------|
| `GET /tabs` | List active Chrome tabs with optional window filter |
| `GET /lifecycle` | List lifecycle tabs (snoozed, queued, watching) |
| `POST /lifecycle/snooze` | Snooze a tab with a wake time or duration |
| `POST /lifecycle/queue` | Queue a tab for later reading |
| `POST /lifecycle/watch` | Watch a page element via CSS selector for changes |
| `POST /lifecycle/{id}/wake` | Wake snoozed/queued/watched tabs back to active |
| `DELETE /lifecycle/{id}` | Permanently remove a lifecycle tab |
| `POST /meeting/start` | Bulk snooze all non-pinned tabs, restore after |
| `POST /meeting/end` | End meeting mode and restore tabs |
| `GET /stats` | Get tab counts and lifecycle breakdown |

## How the bridge and extension communicate

The bridge stores lifecycle data in JSON files and serves it over REST. When a lifecycle action needs to reach the browser (waking a tab, starting meeting mode), the bridge broadcasts a command over WebSocket:

```typescript
// Bridge wake handler (simplified for clarity)
router.post("/lifecycle/:id/wake", async (req, res) => {
  const tab = context.storage.getLifecycleTab(req.params.id);
  if (!tab) { res.status(404).json({ error: "tab not found" }); return; }
  await context.storage.removeLifecycleTab(req.params.id);
  if (context.broadcast) {
    context.broadcast({ type: "command",
      payload: { command: "wake", lifecycleIds: [req.params.id] } });
  }
  res.json({ tab });
});
```

On the extension side, the service worker listens for these commands and performs the actual Chrome API calls:

```typescript
// Extension: handle commands pushed from the bridge
async function handleBridgeCommand(payload: any): Promise<void> {
  if (payload.command === "wake" && payload.lifecycleIds) {
    for (const id of payload.lifecycleIds) {
      const tab = await wakeTab(id);
      if (tab && isAllowedUrl(tab.url)) {
        await chrome.tabs.create({ url: tab.url, windowId: tab.originWindowId });
      }
    }
  }
  if (payload.command === "meeting-start") await activateMeetingMode();
  if (payload.command === "meeting-end") await deactivateMeetingMode();
}
```

The extension also periodically syncs its state to the bridge over HTTP, so the bridge's JSON files stay up to date even when commands come from the popup UI.

## Meeting mode

This is my favorite feature. When I join a meeting, I tell Claude "meeting mode" and it bulk-snoozes every non-pinned tab. My browser goes from 60 tabs to just the 3-4 pinned ones (email, calendar, chat). When the meeting ends, I say "meeting over" and everything comes back exactly where it was, in the correct windows.

Under the hood, `POST /meeting/start` stores all active tab URLs and positions, then closes them. A placeholder tab keeps each window alive so Chrome doesn't collapse empty windows. `POST /meeting/end` reopens everything in the correct windows, then cleans up the placeholder tabs. Pinned tabs are never touched.

Tabs matching configurable exclude patterns (default: `meet.google.com`) are also kept open. This covers a real scenario: you're already in a Google Meet call, you want to clean up your browser, but you don't want to drop out of the call and have to rejoin. The exclude list is configurable, so you can add `zoom.us` or `teams.microsoft.com` if those are your tools.

## Watch mode

Watch mode lets you monitor specific elements on a page without keeping the tab open. You give it a CSS selector, and the extension polls the element's text content for changes. When something changes, it sends a Chrome notification.

Practical uses: monitoring a CI pipeline status badge, watching a PR's review count or checking if a deploy page shows "complete." The CSS selector targeting means it works on any page without needing site-specific integrations.

## Session restore

Chrome's built-in "Continue where you left off" doesn't always work, especially after crashes or forced restarts. The extension solves this by continuously snapshotting all open tabs to Chrome Storage (debounced on every tab create, remove or URL change). On browser startup, it compares the snapshot to what Chrome actually restored and identifies anything missing.

If tabs were lost, the extension shows a notification and a banner in the popup where you can restore all tabs, cherry-pick from a list or dismiss. Snapshots expire after 7 days to avoid restoring stale sessions from weeks ago.

As a fallback, if no local snapshot exists (fresh install, cleared storage), the extension fetches the last known tab list from the bridge server. Since the bridge already receives periodic tab syncs over WebSocket, it always has a recent copy. This means tab restore works across Chrome profile resets as long as the bridge was running.

## Security decisions

Security was a priority from the start. Here are the key decisions and why I made them:

**Origin checking**: The bridge blocks browser cross-origin requests from anything other than `chrome-extension://` origins. Requests with no `Origin` header (curl, scripts) are allowed through since they're local tools, not browser-initiated cross-origin requests.

**Input validation**: Every REST endpoint validates inputs with explicit checks. URLs must be `http://` or `https://`. CSS selectors are length-limited to 500 characters. Timestamps must be positive numbers.

**Storage mutex**: Chrome Storage operations aren't atomic. If two operations try to read-modify-write at the same time, you get race conditions. I added a mutex that serializes all storage writes through a promise chain. It's straightforward but it prevents the "tabs disappearing" bug I hit during development.

**URL validation**: All `chrome.tabs.create` calls are guarded by an `isAllowedUrl()` check that only permits `http://` and `https://` URLs. This prevents any command from opening `file://`, `chrome://` or other privileged URLs.

**No remote execution**: The API can only perform predefined operations. There's no "execute arbitrary JavaScript" endpoint. CSS selectors for watch mode are passed to `document.querySelector`, which is safe and can't execute code.

## Testing

Tests across both packages run with Vitest. The bridge tests make up the bulk of the suite, spinning up a real Express server to test route handlers, storage operations and validation. The extension has focused tests on the lifecycle manager logic.

The tests caught several real bugs. A particularly annoying one: Chrome's `tabs.move` API silently ignores invalid indices instead of throwing, so my "restore tabs to original positions" logic was putting tabs in the wrong order. The fix was to sort tabs by their target index before moving them.

## What I learned

The hardest part wasn't the AI integration. With the skill-based approach, teaching an agent to call a REST API is just writing clear documentation. The hard part was the Chrome extension side: service worker lifecycle, storage race conditions and the WebSocket reconnection logic.

The layered architecture (extension, bridge, skill) adds complexity, but it's worth it. Each layer has a single responsibility, and I can test them independently. The bridge could also serve other clients in the future, like a CLI or a web dashboard.

The skill-based approach turned out to be simpler and more portable than a protocol-specific plugin. Any agent that can read markdown and run curl can integrate with the system. No SDK version compatibility issues, no transport layer debugging. If you're building AI integrations for tools with REST APIs, consider this pattern before reaching for a protocol-specific SDK.

## Try it out

The source code is on [GitHub](https://github.com/ugiordan/tab-manager) and the full documentation is at [ugiordan.github.io/tab-manager](https://ugiordan.github.io/tab-manager/). Clone the repo, load the extension in developer mode and start managing your tabs through lifecycle states. If you use Claude Code (or any AI agent that supports skills), you get hands-free tab management from your terminal.
