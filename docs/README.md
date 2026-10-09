# LazyEditMirror documentation

LazyEditMirror is a dockable panel for **Adobe Premiere Pro** that copies a
Front Camera edit onto a Side Camera track, synced by audio: you cut the
front camera once, the side camera follows, one pass per side-camera file.
Free, open source, runs entirely on your own computer.

The [README](../README.md) is the tour. These pages are the detail.

*Written for LazyEditMirror 1.0.0.*

## Using it

| | |
| --- | --- |
| **[The manual](manual.md)** | Setting up the sequence, the audio helper, every control of the panel, what each line of the summary means, running passes, undo, where the log and the cache live. |
| **[If something goes wrong](troubleshooting.md)** | Symptoms and fixes, every message the panel can show and what it means, and what to send when you report a problem. |

## Changing it

| | |
| --- | --- |
| **[Development](development.md)** | How the panel, the engine, the Premiere adapter and the audio helper fit together, the tests and the mock, the dev loop, and how a release is built. |
| **[API research](api-research.md)** | The Premiere Pro extensibility landscape (UXP vs CEP), the exact API calls the panel uses and the limitations that shaped it, with sources. |
| **[Test protocol](testing.md)** | The manual run-through in Premiere Pro for a new build. |
| **[Changelog](../CHANGELOG.md)** | What changed in every version. |

---

Stuck somewhere? Email **lettertosohan@gmail.com** with the panel's log
file (see the manual). LazyEditMirror is designed and built by
[Raisul Sohan](https://raisulsohan.com/) and is MIT licensed.
