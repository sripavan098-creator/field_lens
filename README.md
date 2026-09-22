# FieldLens

Zero-connectivity field automator. A field worker points a phone at an invoice, a
damaged pipe or a warehouse shelf, speaks what they see, and the phone turns that
into a structured record without any network at all. Back at the office the record
crosses to the desktop over the local link and the desktop puts the worker back on
the exact record they were on.

Nothing in this system calls the internet. There is no account, no cloud relay and
no DNS lookup in any code path.

## Running it

```bash
python fieldlens/server.py --port 12000
```

Then:

- **Phone / mobile PWA** - `http://<this-machine-ip>:12000/`
- **Desktop shell** - `http://127.0.0.1:12000/desktop/`

Both are served by the same process. On a site with no network at all, the phone
can export a portable bundle instead and the file can be carried across on a stick.

Options: `--db` (inbox database), `--inbox` (folder watched for portable bundles),
`--verbose`.

## How the pieces fit

| Piece | File | Job |
| --- | --- | --- |
| Extraction engine | `fieldlens/static/engine.js` | Turns narration + vision into fields, enforces the profile schema, flags anything it is unsure about |
| Local store | `fieldlens/static/store.js` | IndexedDB records and evidence blobs, content hashing, ULIDs |
| Office Kit transfer | `fieldlens/static/transfer.js` | Packs the verified queue, sends it, and knows what happened to every record |
| Mobile capture UI | `fieldlens/static/app.js` | Camera + mic, profile picker, queue review, sync control |
| Desktop inbox | `fieldlens/server.py` | Validates and stores bundles, serves the API and both UIs |
| Flow State Guardian | `desktop/desktop.js` | Watches for a transfer and resumes the worker's last record |
| Record contract | `fieldlens/schemas/record.schema.json` | The shape both sides agree on |

## The parts that are easy to get wrong

**A record that lands twice must not become two ERP rows.** The desktop derives its
own content hash from the bytes it received and deduplicates on that, never on a key
the phone supplies. A phone that retries after a lost ack is recognised as a replay;
anything that tries to reuse one key for two different captures is not believed.

**Evidence is kept, not summarised.** The original frame and audio are stored beside
the extracted fields, and the desktop re-hashes every evidence blob on arrival. A
record whose bytes do not match its stated hash is refused rather than stored with a
quietly broken photograph.

**A record the engine is unsure about does not reach the ERP.** Low confidence, a
missing required field, or a value outside an enum marks the record for review. It
stays out of the active row on the desktop and appears in the "held back" list, and
the phone will not send it in the first place.

**Offline is asserted, not assumed.** A bundle claiming a record was authored with
connectivity is rejected at the envelope, so the "zero connectivity" property is
enforced by the server rather than trusted from the client.

## Tests

```bash
python -m unittest discover -s tests   # server, protocol and desktop shell
node --test tests/*.test.mjs           # engine, and the browser-to-server wire
```

The wire tests in `tests/transfer.test.mjs` start the real Python server and drive it
with the real browser transfer module, so a change to either language that breaks the
bundle format fails in CI rather than on a phone in a field.

## Extraction profiles

Three profiles ship, each with its own field contract: invoice / delivery note,
infrastructure inspection, and warehouse shelf count. The phone prefers a local
Phi-3-Vision model on the NPU and, when the webview cannot host those weights, says
so and falls back to a deterministic rules extractor. It never invents a value to
fill a field.
