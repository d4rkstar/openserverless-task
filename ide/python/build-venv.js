import { $ } from "bun";
import { existsSync, rmSync, statSync, writeFileSync } from "fs";
import { join, resolve, delimiter as pathSeparator } from "path";

// --- Get input arguments ---
const [,, DIR, ZIP] = process.argv;
if (!DIR || !ZIP) {
    console.error("Usage: bun build-venv.js <directory> <zipfile>");
    process.exit(1);
}

const absDir = resolve(DIR);
const absZip = resolve(ZIP);
const venvDir = join(absDir, "virtualenv");
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const pythonPath = join(venvDir, binDir, process.platform === "win32" ? "python.exe" : "python");

// --- Prepend OPS_BIN to PATH and resolve uv path ---
const opsBin = process.env.OPS_BIN;
if (opsBin) {
    process.env.PATH = `${opsBin}${pathSeparator}${process.env.PATH}`;
}
const uvPath = opsBin
    ? join(opsBin, process.platform === "win32" ? "uv.exe" : "uv")
    : "uv";

const requirementsFile = join(absDir, "requirements.txt");

// --- Check if uv is available ---
try {
    await $`${uvPath} --version`.quiet();
} catch {
    console.error(`❌ uv not found at ${uvPath}`);
    process.exit(1);
}

// --- 1. Create virtualenv if missing ---
if (!existsSync(venvDir)) {
    await $`${uvPath} venv ${venvDir}`;
}

// --- 2. Install dependencies into the virtualenv ---
try {
    await $`${uvPath} pip install -r ${requirementsFile} --python ${pythonPath}`;
} catch (err) {
    console.error(`❌ Failed to install dependencies from ${requirementsFile}`);

}

// --- 4. Ensure virtualenv/bin/activate exists ---
const activatePath = join(venvDir, binDir, process.platform === "win32" ? "activate.bat" : "activate");
if (!existsSync(activatePath)) {
    writeFileSync(activatePath, "");
}

// --- 5. Remove existing ZIP if present ---
if (existsSync(absZip)) {
    rmSync(absZip);
}

// --- 6. Zip the virtualenv directory ---
await $`7zz a ${absZip} -tzip ${venvDir} >/dev/null`;

// --- 7. Show resulting ZIP file size ---
const stats = statSync(absZip);
console.log(`${ZIP} - ${stats.size} bytes`);

// --- 8. Write timestamp into virtualenv/date ---
writeFileSync(join(venvDir, "date"), new Date().toISOString() + "\n");
