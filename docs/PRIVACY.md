# Privacy Policy — מחיקון · Mechikon (Chrome Extension)

_Last updated: 2026-08-15_

Mechikon masks personal and sensitive details in text before you send it to an AI
chat. It is built so that **your sensitive data never leaves your browser.**

## What the extension does with your data

- **Text you choose to mask** (typed in a chat composer, or from a file you drop
  into the popup) is processed **entirely on your device**. It is never uploaded
  to us or to any third party. The AI chat only ever receives the *masked* text,
  in which real values are replaced by neutral tokens such as `[NAME_1]`.
- **Restore key.** To let you turn tokens back into the original values, the
  mapping (token → original value) is stored **locally** in your browser
  (`chrome.storage.local`) and expires automatically after 24 hours. It is never
  transmitted. You may also export it as a file that stays on your computer.
- **No accounts, no tracking, no analytics, no advertising.** The extension has
  no servers of its own and does not collect usage data, telemetry, or
  identifiers.

## Network access

The only network request the extension makes is a **one-time download of the
Hebrew name-detection model** from the Hugging Face CDN (`huggingface.co` /
`*.hf.co`). This downloads model *weights to your browser*; **none of your text
or personal data is sent** in that request. After the first download the model is
cached locally and reused.

## Permissions and why they are needed

- **storage** — to keep the local restore key (24h) so you can un-mask answers.
- **offscreen** — to run the name-detection model in the background, on-device.
- **host access to `huggingface.co` / `*.hf.co`** — solely to download the model
  weights described above.
- **Content scripts on ChatGPT, Claude, and Gemini** — to show the masking
  controls inside those chat composers. The extension does not read or transmit
  page content anywhere; it acts only on the text you choose to mask.

## Data sharing

We do not sell, share, or transmit your data to anyone. There is nothing to
share — processing happens locally and produces no data on our side.

## Open source

Mechikon's engine and extension are open source (AGPL-3.0). You can inspect
exactly what the code does.

## Contact

Questions: yehiel@bai-solutions.com
