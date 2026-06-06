---
name: chrome-extension
description: Chrome extension development, Web Store submission, and review process.
tagline: Chrome extension development and Web Store submission
last-updated: 2026-06-06
---

## Chrome Extension Development

This skill covers Manifest V3 Chrome extension development, Web Store submission requirements, and the review process.

### When to use

Use this skill when:
- Building or validating a Chrome extension manifest
- Submitting to Chrome Web Store
- Preparing for Chrome review (single purpose, permissions, privacy)
- Configuring Manifest V3 features

### Required manifest fields

```json
{
  "manifest_version": 3,
  "name": "Your Extension",
  "version": "1.0.0",
  "description": "Clear, concise description (≤132 characters for short description)",
  "permissions": ["storage", "..."],
  "host_permissions": ["https://example.com/*"],
  "action": { ... },
  "background": {
    "service_worker": "background.js"
  }
}
```

### Chrome Web Store submission requirements

#### 1. Single purpose declaration (max 1000 chars)

Your extension must have a single, narrow, easy-to-understand purpose.

**Example:**
> This extension adds English subtitles to Danish TV content on DR's streaming platform (dr.dk/drtv). It hijacks DR's native subtitle button to inject a three-way toggle (Off / Dansk / English). When "English" is selected, the extension captures the Danish subtitle stream, sends it to a user-configured LLM provider, and displays the translated English cues as a native TextTrack on the video player. Works only on dr.dk/drtv/* URLs. No ads, no tracking, no unrelated features.

**Tips:**
- Be specific about what it does and where it works
- Mention what it does NOT do (no ads, no tracking)
- Keep it focused — avoid "suite" or "toolbox" language

#### 2. Permission justifications (max 1000 chars each)

For each permission, explain why it's needed for your single purpose:

| Permission | What to explain |
|------------|-----------------|
| `storage` | What user settings/data you persist locally |
| `webNavigation` | Why you need to detect page navigation (e.g., SPA handling) |
| `declarativeNetRequest` | CORS/API call requirements for MV3 service workers |
| `host_permissions` | Which hosts you access and why |

**Example (storage):**
> Stores the user's LLM provider selection, API key, and custom endpoint URL in chrome.storage.local. This data persists across browser sessions so users don't need to re-enter credentials. The API key never leaves the user's machine except when sent directly to their chosen LLM provider. No other data is stored.

**Example (webNavigation):**
> Detects when the user navigates to episode pages. Required because the site is a single-page application (SPA) that dynamically loads content without full page reloads. Without webNavigation, the extension wouldn't know when to activate on new episodes within the same browsing session.

**Example (declarativeNetRequest):**
> Dynamically registers CORS rules to allow the background service worker to fetch responses from external APIs. When translation starts, the extension adds a temporary rule permitting cross-origin responses from the LLM endpoint. Required because Chrome MV3 service workers cannot use XMLHttpRequest with loose CORS.

**Example (host_permissions):**
> - `https://www.dr.dk/*` — Inject subtitle toggle and fetch subtitle files from DR's player
> - `https://inference.alexandra.dk/*` — Default LLM endpoint for translation
> - Optional `https://*/*` — Allow custom LLM endpoints if user configures them

#### 3. Remote code declaration

**Question:** Are you using remote code?

**Answer:** No (if all JS is bundled)

**Explanation:**
> All JavaScript is bundled at build time using esbuild. No remote code is loaded at runtime. The extension is fully self-contained in the submitted package. No `<script>` tags pointing to external URLs, no dynamic `eval()`, no remote WASM, no CDN-loaded modules.

If you DO use remote code, you must disclose it and may face additional scrutiny.

#### 4. Data collection disclosure

You must declare what user data you collect (if any):

**Categories to consider:**
- Personally identifiable information (name, email, etc.)
- Health information
- Financial/payment information
- Authentication information (passwords, credentials)
- Personal communications
- Location
- Web history
- User activity (clicks, keystrokes, etc.)
- Website content (text, images, videos)

**If you collect nothing:**

> This extension collects zero user data. All data stays on the user's machine or flows directly to their chosen LLM provider:
> - API key stored locally in chrome.storage.local, never transmitted to the developer
> - Subtitle text sent directly from user's browser to their LLM provider — developer does not intercept or store
> - Cache stored locally in IndexedDB, not synced or transmitted
> - No telemetry, no analytics, no tracking

Leave all data collection checkboxes **unchecked** if none apply.

#### 5. Privacy policy URL

Required if you collect any user data. Recommended even if you don't.

**Host it on:**
- GitHub Pages
- Your own domain
- A public gist (less formal)

**Must include:**
- What data you collect (or "none")
- How you use it
- Whether you share it with third parties
- How users can contact you

### Screenshot requirements

| Requirement | Specification |
|-------------|---------------|
| **Count** | 1–5 screenshots (at least 1 required) |
| **Size** | Exactly 1280×800 OR 640×400 pixels |
| **Format** | JPEG or 24-bit PNG (no alpha channel) |
| **Content** | Show actual extension UI in action |

**Tips:**
- Use JPEG for smaller file sizes
- Resize to exact dimensions (Chrome is strict)
- Remove alpha channel (no transparency)
- Show the extension's main functionality

### Review process

1. **Submit** extension via Chrome Web Store Developer Dashboard
2. **Pay $5** one-time developer fee (if first time)
3. **Wait for review** — typically 1–3 days
4. **Email notification** when approved (or if changes needed)
5. **Publishes automatically** upon approval

**Common rejection reasons:**
- Unclear single purpose
- Unjustified permissions
- Missing privacy policy (if collecting data)
- Remote code without disclosure
- Misleading description or screenshots

### Build and package workflow

1. **Build** the extension:
   ```bash
   npm run build
   ```

2. **Package** for submission:
   ```bash
   npm run package
   ```

3. **Upload** the zip file to Chrome Web Store Dashboard

### Submission checklist

- [ ] Single purpose description written (~1000 chars)
- [ ] Permission justifications ready (max 1000 chars each)
- [ ] Remote code declaration prepared ("No" if bundled)
- [ ] Data collection disclosure written (or "none")
- [ ] Privacy policy URL ready
- [ ] Screenshots resized to 1280×800 (JPEG, no alpha)
- [ ] Extension icon (128×128 minimum)
- [ ] `$5 fee` paid (if first-time developer)
- [ ] `npm run package` produces clean zip

### Differences from Firefox AMO

| Chrome Web Store | Firefox AMO |
|------------------|-------------|
| No `data_collection_permissions` | Requires `data_collection_permissions` |
| Uses `key` for extension ID | Uses `browser_specific_settings.gecko.id` |
| Validates during review | Validates on upload |
| Manual review always | Auto-approval possible |
| $5 one-time fee | No fee |
| Screenshots: 1280×800 or 640×400 exactly | Screenshots: 2400×1800 max |
| Source review on request | Source submission required |

### References

- [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- [Manifest V3 Overview](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Single Purpose Policy](https://chrome.google.com/webstore/program-policies/developer-program-agreement)
- [Privacy Policy Requirements](https://chrome.google.com/webstore/program-policies/developer-program-agreement)
- [Permission Best Practices](https://developer.chrome.com/docs/extensions/develop/best-practices/security#permissions)
