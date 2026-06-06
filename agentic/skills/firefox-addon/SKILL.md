---
name: firefox-addon
description: Firefox add-on development, manifest validation, and AMO submission.
tagline: Firefox extension development and AMO submission
last-updated: 2026-06-06
---

## Firefox Add-on Development

This skill covers Manifest V3 Firefox extension development, including required manifest fields, AMO validation, and submission.

### When to use

Use this skill when:
- Building or validating a Firefox extension manifest
- Submitting to Firefox Add-ons (AMO)
- Fixing AMO validation errors
- Configuring `browser_specific_settings` for Firefox

### Required manifest fields

All new Firefox extensions **must** include `data_collection_permissions` in `browser_specific_settings.gecko`. This is validated on AMO submission.

#### For extensions that collect NO data (recommended for local/self-contained extensions):

```json
{
  "browser_specific_settings": {
    "gecko": {
      "id": "your-extension@local",
      "data_collection_permissions": {
        "required": ["none"]
      }
    }
  }
}
```

This is appropriate when the extension:
- Stores data only in `chrome.storage.local` / `browser.storage.local`
- Makes API calls directly to user-specified endpoints
- Has no telemetry, analytics, or remote data transfer

#### For extensions that DO collect data:

```json
{
  "data_collection_permissions": {
    "required": ["locationInfo", "browsingHistory", "..."],
    "optional": ["technicalAndInteraction", "..."]
  }
}
```

**Available data types:**

Required or optional:
- `bookmarks`, `browsingHistory`, `cookies`, `credentialsOrAuth`
- `downloads`, `extensionDataAndConfig`, `geolocation`
- `locationInfo`, `personalCommunications`, `personalDataAndFiles`, `sensitiveInfo`

Optional only (`technicalAndInteraction` cannot be required):
- `technicalAndInteraction`

### AMO validation errors and fixes

| Error | Fix |
|-------|-----|
| `"data_collection_permissions" property is missing` | Add field to `browser_specific_settings.gecko` |
| `must have required property 'required'` | Include `"required": [...]` array |
| `"required" must be array` | Use `["none"]` or list of data types, not boolean/string |
| `"data_collection_permissions" must be object` | Use `{ "required": [...] }`, not just `[]` |

### AMO submission form requirements

When submitting to AMO, you'll need to complete several form sections:

#### 1. Single purpose declaration
Confirm your extension has a single, narrow purpose. Be ready to explain it in ~1000 characters.

#### 2. Permission justifications
For each permission in your manifest, provide a justification (max 1000 chars each):
- **storage** — explain what user settings/data you persist
- **webNavigation** — explain why you need to detect page navigation
- **declarativeNetRequest** — explain CORS/API call requirements
- **host_permissions** — explain which hosts you access and why

#### 3. Source code submission
Mozilla requires source code for reviewed extensions:
- Submit a separate source zip (not the built extension)
- Include raw, untranspiled source files
- Include `README.md` or `BUILD.md` with step-by-step build instructions
- Include build script (e.g., `build.mjs`, `package.json`)
- List Node.js/npm version requirements
- Max file size: 200 MB

#### 4. Screenshots
- PNG or JPG format
- Maximum size: 2400×1800 pixels
- At least one screenshot greatly increases install likelihood

### Build and package workflow

1. **Build** the extension:
   ```bash
   npm run build
   ```

2. **Package** for submission (produces store-ready zip):
   ```bash
   npm run package
   ```

3. **Prepare source package**:
   ```bash
   # Include: src/, build script, package.json, README, manifests
   # Exclude: node_modules/, dist/, build output
   zip -r extension-source.zip src/ build.mjs package.json README.md manifest.firefox.json
   ```

4. **Validate** on AMO before submitting:
   - Go to [AMO Developer Hub](https://addons.mozilla.org/developers/)
   - Upload the built extension zip
   - Upload source zip when prompted
   - Fix any validation errors before final submission

### Submission checklist

- [ ] `data_collection_permissions` field present in manifest
- [ ] Extension ID set in `browser_specific_settings.gecko.id`
- [ ] Screenshots ready (1280×800 or 2400×1800 max, PNG/JPG)
- [ ] Privacy policy URL (recommended)
- [ ] Source package prepared with build instructions
- [ ] Permission justifications written (max 1000 chars each)
- [ ] Single purpose description ready (~1000 chars)
- [ ] `npm run package` produces clean zip
- [ ] AMO validation passes with no errors/warnings

### Differences from Chrome Web Store

| Firefox AMO | Chrome Web Store |
|-------------|------------------|
| Requires `data_collection_permissions` | No equivalent field |
| Uses `browser_specific_settings.gecko` | Uses `key` for extension ID |
| Validates on upload | Validates during review |
| Requires source code submission | Source review on request |
| Auto-signs approved extensions | Requires manual review |
| No fee | $5 one-time developer fee |
| Screenshots: 2400×1800 max | Screenshots: 1280×800 or 640×400 exactly |

### References

- [Firefox built-in consent for data collection](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Short link](https://mzl.la/firefox-builtin-data-consent)
- [AMO Developer Hub](https://addons.mozilla.org/developers/)
- [Extension Workshop](https://extensionworkshop.com/)
- [Source code submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)
