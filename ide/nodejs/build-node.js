// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import {$} from "bun";
import {existsSync, rmSync, statSync, writeFileSync, readFileSync} from "fs";
import {delimiter as pathSeparator, join, resolve} from "path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { rm } from "node:fs/promises";

async function calculateHash(file) {
    const hash = createHash("sha256");

    await pipeline(
        createReadStream(file),
        hash
    );

    return (await hash.digest("hex")).toString().trim();
}

async function readHash(file) {
    if (!existsSync(file))
        return null;

    return (await readFileSync(file)).toString().trim();
}

// --- Get input arguments ---
const [,, DIR, ZIP] = process.argv;
if (!DIR || !ZIP) {
    console.error("Usage: bun build-node.js <directory> <zipfile>");
    process.exit(1);
}

const absDir = resolve(DIR);
const absZip = resolve(ZIP);

const nodeModulesDir = join(absDir, "node_modules");

// --- Prepend OPS_BIN to PATH and resolve bun and 7zz path ---
const opsBin = process.env.OPS_BIN;
if (opsBin) {
    process.env.PATH = `${opsBin}${pathSeparator}${process.env.PATH}`;
}

const bunName = process.platform === "win32" ? "bun.exe" : "bun";
const szzName = process.platform === "win32" ? "7zz.exe" : "7zz";

const szzPath = opsBin ? join(opsBin, szzName) : szzName;

// --- Check if 7zz is available ---
try {
    await $`${szzPath} i`.quiet();
} catch {
    console.error(`❌ 7zz not found at ${szzPath}`);
    process.exit(1);
}

// Change working directory
process.chdir(absDir);


// Hash from package.json
const packageJsonFile = join(absDir, "package.json");
const hashDigest = await calculateHash(packageJsonFile);

// Hash from virtualenv
const hashFile = join(nodeModulesDir, "hash");
const hash = await readHash(hashFile);

let isToRebuild = true;
if (hashDigest === hash) {
    isToRebuild = false;
} else {
    console.log('package.json file have been changed. Need to rebuild node_modules!');
}

// Run `npm install`
if (isToRebuild) {
    try {
        await rm(nodeModulesDir, { recursive: true, force: true });
        await $`${bunName} install`;
    } catch (err) {
        console.error(`❌ Failed to install dependencies from package_json`);
    }
}



// Remove existing zip if it exists
try {
    await Bun.file(zip).remove();
} catch (err) {
    // Ignore if it doesn't exist
}

// Zip node_modules using 7zz
// --- 5. Remove existing ZIP if present ---
if (existsSync(absZip)) {
    rmSync(absZip);
}

// --- 6. Zip the virtualenv directory ---
await $`7zz a ${absZip} -tzip node_modules >/dev/null`;

// --- 7. Show resulting ZIP file size ---
const stats = statSync(absZip);
console.log(`${ZIP} - ${stats.size} bytes`);

writeFileSync(hashFile, hashDigest);



