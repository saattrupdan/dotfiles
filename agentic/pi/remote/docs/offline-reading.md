# Offline reading decisions

Product decisions from the design interview. Implementation has not started.

## Offline library

- Offline copies survive closing and reopening the phone app.
- Offline reading has no additional app unlock prompt. See
  [the privacy decision](adr/0001-persistent-offline-reading.md).
- Automatically save the 20 most recently active eligible conversations,
  including ones not opened on the phone.
- Save the latest five exchanges and retain older messages already loaded on the
  phone, rather than automatically downloading full histories.
- Save text, reasoning and tool outputs, not images. Clearly mark images that
  are unavailable offline.
- Synchronize while Pi Remote is running and connected. Do not assume continuous
  background synchronization while the phone app is closed.
- Keep copies until replaced by newer conversations or manually cleared; no
  time-based expiration.
- Provide one Clear all offline conversations action. Clearing copies does not
  delete original conversations on the laptop. Individual removal is not needed.

## Opening and reconnecting

- Try the laptop first rather than immediately displaying saved content.
- Fall back to the saved conversation after at most five seconds, or sooner if
  the connection fails definitively. The deadline includes startup and connection
  checks rather than adding five seconds after each stage.
- Clearly label saved content as offline and show its last successful sync time.
- Missing saved content is unavailable offline, not an empty conversation.
- Keep checking for connectivity after showing an offline copy.
- Automatically refresh after authenticated reconnection, preserving the reader's
  position. Restore normal controls only after the live state is ready.
- Reading saved content must not depend on laptop authentication succeeding.
  Saved content never establishes authorization to control the laptop.

## Read-only behavior

- Offline conversations are completely read-only, including the composer.
- Send and New conversation remain visible but disabled. Other laptop-changing
  controls are disabled too.
- No offline command queue, automatic sending or new conversation creation.
- Existing drafts must not be destroyed by entering offline mode; they cannot be
  edited or sent until connected.

## Privacy and storage

- Incognito conversations remain excluded from phone access and offline copies.
- When the phone learns a conversation is hidden, deleted or no longer accessible,
  remove its offline copy. An unreachable phone cannot learn about laptop-side
  deletion or revocation until it reconnects.
- Someone using the unlocked phone can read offline copies. No additional app
  biometric or passcode check is required for offline reading.
- The browser or phone can evict saved app data. Report missing copies honestly;
  offline storage is not a backup of laptop histories.

## Implementation follow-through

- Keep the offline reader separate from live authentication and action state.
- Enforce text-only storage, including stripping embedded image data.
- Bound storage and background synchronization work without blocking live opens.
- Test reopening offline, the five-second fallback, unavailable images, disabled
  controls, clearing copies, exclusion and purge, and position-preserving refresh
  through public user workflows.
