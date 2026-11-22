# Persistent offline reading without an additional app unlock

Pi Remote must allow saved conversations to be read after the phone app closes
and reopens while the laptop is unreachable. Offline copies persist across app
restarts, replacing the earlier memory-only conversation policy.

Offline reading requires no additional Pi Remote biometric or passcode prompt.
The user accepts that someone using the unlocked phone can read saved copies.
This does not grant permission to control the laptop without authentication.

Conversation selection, retention, attachment coverage and reconnection behavior
are recorded in [the offline-reading design](../offline-reading.md). These are
product decisions, not implemented functionality.
