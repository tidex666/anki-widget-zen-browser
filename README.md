# Anki vibe coded widget :c

A small glass widget for the Zen Browser sidebar that shows how many Anki cards are due today, read straight from AnkiWeb. Desktop Anki does not need to be running.

- Big **due** number (review + learning) with **+N new** underneath, or **all done** when nothing is left.
- Hover for a gear (deck selection) and a refresh button.
- Click the widget to jump to your AnkiWeb tab (or open one).
- Same look and size as the minimised SoundCloud widget, and always sits above it.

## Requirements

- Zen Browser with a userscript loader (fx-autoconfig or Sine).
- You are logged in to [ankiweb.net](https://ankiweb.net) in this browser.

## Install

Put `anki-widget.uc.js` in the mod folder (Sine: the folder named after the `id` in `theme.json`, the file name must match the one listed there) or in your `chrome/JS` folder, then restart the browser. If it does not show up, clear the startup cache first (`about:support` > "Clear startup cache").

## Choosing decks

Click the gear and untick the decks you do not want counted, for example abandoned ones. Nothing is changed in Anki itself.

- Unticking a deck hides it and all its sub-decks.
- Unticking only a sub-deck subtracts its cards from the parent. This is approximate if Anki's daily limits cap the parent.
- New decks are counted by default. "Show all" resets the selection.

## Settings (`about:config`)

| Preference | Default | What it does |
| --- | --- | --- |
| `anki-widget.refresh-minutes` | `10` | How often to refresh in the background (needs a restart). |
| `anki-widget.excluded` | `[]` | JSON list of hidden deck paths. Normally edited through the gear. |

## When it refreshes

On startup, every 10 minutes, when you come back to the window and the numbers are older than 2 minutes, and when you press refresh. While the window is minimised or hidden it makes no requests.

## Notes

- It uses AnkiWeb's own (undocumented) deck list endpoint, so a change on their side could break it.
- Not affiliated with Anki or Ankitects. The card icon is an original drawing, not the official logo.
- Everything runs locally in your browser; the only network request is to ankiweb.net.