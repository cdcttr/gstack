/**
 * End-to-end test: snapshot → tap → fill using @w refs
 * through the actual command handlers.
 */
import { VmServiceClient } from "../src/vm-service";
import { AdbBridge } from "../src/adb-bridge";
import { FlutterManager } from "../src/flutter-manager";
import { handleSnapshot } from "../src/snapshot";
import { handleWriteCommand } from "../src/write-commands";
import { handleReadCommand } from "../src/read-commands";
import { handleMetaCommand } from "../src/meta-commands";
import * as fs from "fs";

const uri = process.argv[2] || "ws://127.0.0.1:63872/L_chr7SIj_E=/ws";

const vmService = new VmServiceClient();
const adb = new AdbBridge("emulator-5554");
const fm = new FlutterManager(vmService, adb);
await fm.attach(uri);

// First dismiss keyboard and hot restart to get a clean state
console.log("Hot restarting for clean state...");
await handleWriteCommand(fm, adb, "restart", []);
await new Promise(r => setTimeout(r, 2000));

// Step 1: Snapshot
console.log("\n=== Step 1: snapshot ===");
const snapshot = await handleSnapshot(fm, []);
console.log(snapshot);

// Find the email field, password field, and sign in button refs
const lines = snapshot.split("\n");
let emailRef = "", passwordRef = "", signInRef = "";
for (const line of lines) {
  if (line.includes("email_field")) emailRef = line.trim().split(" ")[0];
  if (line.includes("password_field")) passwordRef = line.trim().split(" ")[0];
  if (line.includes("sign_in_button")) signInRef = line.trim().split(" ")[0];
}
console.log(`\nResolved refs: email=${emailRef}, password=${passwordRef}, signIn=${signInRef}`);

if (!emailRef || !passwordRef || !signInRef) {
  console.error("Could not find required widget refs!");
  process.exit(1);
}

// Step 2: Fill email
console.log("\n=== Step 2: fill email ===");
const fillEmail = await handleWriteCommand(fm, adb, "fill", [emailRef, "claude@anthropic.com"]);
console.log(fillEmail);
await new Promise(r => setTimeout(r, 500));

// Step 3: Fill password
console.log("\n=== Step 3: fill password ===");
const fillPassword = await handleWriteCommand(fm, adb, "fill", [passwordRef, "sup3rS3cret"]);
console.log(fillPassword);
await new Promise(r => setTimeout(r, 500));

// Step 4: Dismiss keyboard
console.log("\n=== Step 4: dismiss keyboard ===");
await handleWriteCommand(fm, adb, "back", []);
await new Promise(r => setTimeout(r, 300));

// Step 5: Tap sign in
console.log("\n=== Step 5: tap sign in ===");
const tapSignIn = await handleWriteCommand(fm, adb, "tap", [signInRef]);
console.log(tapSignIn);
await new Promise(r => setTimeout(r, 1000));

// Step 6: Screenshot
console.log("\n=== Step 6: screenshot ===");
const screenshotResult = await handleMetaCommand(fm, adb, "screenshot", ["/tmp/e2e-ref-tap.png"]);
console.log(screenshotResult);

// Step 7: Check what text is on screen
console.log("\n=== Step 7: text ===");
const textResult = await handleReadCommand(fm, adb, "text", []);
console.log(textResult);

console.log("\nDone! Check /tmp/e2e-ref-tap.png and the emulator.");

vmService.close();
process.exit(0);
