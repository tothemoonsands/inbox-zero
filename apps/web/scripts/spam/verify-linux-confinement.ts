import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdf, segmentText } from "../../utils/spam/extractor";
import { runIsolatedExtractor } from "../../utils/spam/isolated-process";

if (process.platform !== "linux")
  throw new Error("Run this check on the Linux deployment host");
const folder = await mkdtemp(join(tmpdir(), "inbox-confinement-check-"));
const previous = process.env.INBOX_CONFINEMENT_CANARY;
try {
  const canary = join(folder, "private-canary");
  await writeFile(canary, "synthetic private marker", { mode: 0o600 });
  const probe = join(folder, "probe.mjs");
  await writeFile(
    probe,
    `import fs from 'node:fs';import net from 'node:net';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const network=await new Promise(resolve=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false)});});
console.log(JSON.stringify({canary:fs.existsSync(input.canary),environment:!!process.env.INBOX_CONFINEMENT_CANARY,proc:fs.existsSync('/proc/self/environ'),network}));`,
  );
  process.env.INBOX_CONFINEMENT_CANARY = "synthetic private marker";
  const result = await runIsolatedExtractor(process.execPath, [probe], {
    canary,
  });
  assert.deepEqual(result, {
    canary: false,
    environment: false,
    proc: false,
    network: false,
  });
  const tokens = await segmentText([
    "A synthetic message for confinement verification.",
  ]);
  assert.ok(tokens.size === 1);
  const pdf = await extractPdf(
    await readFile(
      join(
        process.cwd(),
        "utils/spam/fixtures/native-pdfs/synthetic-four-pages.pdf",
      ),
    ),
  );
  assert.equal(pdf.valid, true);
  assert.equal(pdf.pageCount, 4);
  console.log(
    JSON.stringify({
      confinement: true,
      segmentation: true,
      syntheticPdf: true,
    }),
  );
} finally {
  if (previous === undefined) delete process.env.INBOX_CONFINEMENT_CANARY;
  else process.env.INBOX_CONFINEMENT_CANARY = previous;
  await rm(folder, { recursive: true, force: true });
}
