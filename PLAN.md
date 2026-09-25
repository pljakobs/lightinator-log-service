# Plan for Log Viewer
## Crash Reporter
Now that we have a crash decoder, we can inspect what happened and create a github issue with the given crash.
We don't want to create recurring issues, so we'd have to find a fingerprint.
A good fingerprint would be 
{
  "exccause":exccause,
  "pc"=sha256(decoded line of location),
  "tos"=sha256(decoded line of top stack location (calling function))
}

as a fingerprint, it probably makes sense to use the last four bytes of both sha256 values and drop the whole thing into a searchable field of the issue such as

### abort at /opt/Sming/Sming/Arch/Esp8266/Components/libc/src/libc_replacements.c:124 [00000004::4d7a336a::21a563a2]

with 00000004::4d7a336a::21a563a2 being the fingerprint
this way, the tool can, when a new crash is decoded, search the repo for an issue with that fingerprint and, if it does not find one, create a new issue.

## crash decoder:
- we could include fetching referenced source files from their respective github repos such us github/pljakobs/esp-rgbww-firmware, espressif/esp-idf - not sure if esp-quick-toolchain is still available.
This would also include any submodules referred in those repos

In an ideal world, we might be able to query an ai model to help us provide a bit of information beyond just the bare decoded dump, but that's not a must. Can we use antigravity for that? Suggest a good prompt to provide meaningful information about a given crash dump including the code lines. If the code lines are in Sming or esp-rgbww-firmware, we can even provide the source file by fetching it from github

What needs to be added:
 - [x] installer haves to install gh cli
 - [x] extend the crash decode logic with the crash reporter (that should be asynchronous from the decoder) 
 - [x] extend the settings ui with a way to configure 
   - the repo (there may be different repos for different firmware sources, currently only Lightinator is use)
   - the access token for that repo
   - [x] the database needs to be extended with 
     - a table for crashes containing the issue url, 
     - a pointer to the crash in the log
     - a pointer to the issue on github

ideally, the same logic would also work for gitlab, gitea, codeberg etc

## crash display
- add an extra page with a list of recent crashes, clickable to the actual crash decode

## log display
- [x] when the user scrolls away from the end of the log, the display should not automatically jump to an updated position unless the user scrolls anywhere else.
- [x] when the log is at a non-end position, a "jump to end" button should enable that takes the log back to the end and starts auto scrolling
- [x] jump to previous / next reboot needs to be fixed
  - verify how the restart/reboot markers are injected. Since 
  - in both cases, the reboot marker should be placed in the top line
  - auto scrolling should be disabled (just as with any other non-end including position)
- [x] add a function to see a list of reboots per controller and jump to the respective log part (similar to journalctl --boot -x but graphical)

## controllers page
- need to add a function to remove controllers that are no longer relevant
  - remove single controllers
  - remove multiple controllers
  - remove controllers by "time since last seen"
  - copy the update function from http://github.com/pljakobs/esp_rgb_webapp2 firmwareUpdateCard.vue into the LogViewer Controllers page (or implement equivalent functionality)

## controllers inventory
- controllers should be uniquely identified by their system id
- we need a configurable value to delete controllers that have not been seen for nn days (default 30)
  - this should also delete logs associated with those controllers

## what's new
- clicking the build number in the UI shows what changed (from commit messages), as a running list per build so it's obvious at a glance what was implemented when

