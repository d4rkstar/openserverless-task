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

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { expandEnv } from "./env_utils";
const { parse } = await import("shell-quote");

// Map of requirement files to their corresponding language kinds
const REQUIREMENT_MAPPING = {
  "requirements.txt": "python",
  "package.json": "nodejs",
  "composer.json": "php",
  "pom.xml": "java",
  "go.mod": "go",
  "Gemfile": "ruby",
  "project.json": "dotnet",
};

/**
 * Get the language kind for a given requirement file
 * @param {string} filename - The requirement file name
 * @returns {string|null} - The language kind or null if not found
 */
function getKindFromRequirement(filename) {
  return REQUIREMENT_MAPPING[filename] || null;
}

/**
 * Compute MD5 hash of a file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} - MD5 hash in hex format
 */
async function computeFileHash(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Get auth token from ops command
 * @returns {Promise<string>} - Auth token
 */
async function getAuthToken() {
  const cmd = "ops -wsk property get --auth";
  const cmdArgs = parse(expandEnv(cmd)).filter((arg) => typeof arg === "string");

  const proc = Bun.spawn(cmdArgs, {
    shell: true,
    env: process.env,
    stdout: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse output like "whisk auth		d97403a8-c1aa-49b3-ad5a-50b380ec3ab1:8YpXsnlSBrqWydMRQd4AuOMQ57obmczwi0fAWQlewbGjKhqMxeSRJ24RdsKGefrl"
  const match = output.match(/whisk auth\s+(.+)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  throw new Error("Failed to get auth token from ops command");
}

/**
 * Get API host from ops config
 * @returns {Promise<string>} - API host URL
 */
async function getApiHost() {
  const cmd = "ops -wsk property get --apihost";
  const cmdArgs = parse(expandEnv(cmd)).filter((arg) => typeof arg === "string");

  const proc = Bun.spawn(cmdArgs, {
    shell: true,
    env: process.env,
    stdout: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse output like "whisk API host		https://api.example.com"
  const match = output.match(/whisk API host\s+(.+)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  throw new Error("Failed to get API host from ops command");
}

/**
 * Load and parse runtimes.json
 * @returns {Promise<Object>} - Runtimes configuration
 */
async function loadRuntimes() {
  const opsRoot = process.env.OPS_ROOT;
  const runtimesPath = path.join(opsRoot, "runtimes.json");
  const content = await fs.readFile(runtimesPath, "utf-8");
  return JSON.parse(content);
}

/**
 * Get default runtime image for a language kind
 * @param {string} kind - Language kind (python, nodejs, etc.)
 * @returns {Promise<string>} - Runtime image (e.g., "apache/openserverless-runtime-python:v3.12-2506091954")
 */
async function getDefaultRuntimeImage(kind) {
  const runtimes = await loadRuntimes();
  const languageRuntimes = runtimes.runtimes[kind];

  if (!languageRuntimes || languageRuntimes.length === 0) {
    throw new Error(`No runtime found for kind: ${kind}`);
  }

  // Find the default runtime
  const defaultRuntime = languageRuntimes.find((r) => r.default === true);
  if (!defaultRuntime) {
    throw new Error(`No default runtime found for kind: ${kind}`);
  }

  const { prefix, name, tag } = defaultRuntime.image;
  return `${prefix}/${name}:${tag}`;
}

/**
 * Get username from environment variable
 * @returns {string} - Username from OPSDEV_USERNAME
 * @throws {Error} - If OPSDEV_USERNAME is not set
 */
function getUsername() {
  const username = process.env.OPSDEV_USERNAME;
  if (!username) {
    throw new Error("OPSDEV_USERNAME environment variable is not set. Cannot build custom images.");
  }
  return username;
}

/**
 * Load cached image hash for a language kind
 * @param {string} kind - Language kind
 * @returns {Promise<string|null>} - Cached hash or null if not found
 */
async function loadCachedImageHash(kind) {
  const cachePath = path.join(process.env.OPS_PWD || process.cwd(), ".ops", `image.${kind}`);
  try {
    const hash = await fs.readFile(cachePath, "utf-8");
    return hash.trim();
  } catch (error) {
    return null;
  }
}

/**
 * Save image hash to cache
 * @param {string} kind - Language kind
 * @param {string} hash - Image hash
 */
async function saveCachedImageHash(kind, hash) {
  const opsDir = path.join(process.env.OPS_PWD || process.cwd(), ".ops");

  // Create .ops directory if it doesn't exist
  try {
    await fs.mkdir(opsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }

  const cachePath = path.join(opsDir, `image.${kind}`);
  await fs.writeFile(cachePath, hash);
}

/**
 * Build a custom runtime image via admin API
 * @param {string} requirementFile - Path to requirement file
 * @returns {Promise<string>} - Image tag (hash)
 */
export async function buildImage(requirementFile) {
  const filename = path.basename(requirementFile);
  const kind = getKindFromRequirement(filename);

  if (!kind) {
    console.log(`⚠️ Unknown requirement file type: ${filename}`);
    return null;
  }

  console.log(`🔨 Building image for ${kind} from ${requirementFile}`);

  // Compute hash of requirement file
  const hash = await computeFileHash(requirementFile);
  console.log(`📊 Computed hash: ${hash}`);

  // Check if we already built this image
  const cachedHash = await loadCachedImageHash(kind);
  console.log(`📊 Cached hash: ${cachedHash || 'none'}`);

  if (cachedHash === hash) {
    console.log(`✅ Image already built for ${kind} (hash: ${hash})`);
    return hash;
  }

  console.log(`🔄 Hash mismatch, building new image...`);

  // Get username, auth token and API host
  const username = getUsername();
  const authToken = await getAuthToken();
  const apiHost = await getApiHost();

  // Get source runtime image
  const sourceImage = await getDefaultRuntimeImage(kind);

  // Build target image tag
  const targetImage = `${username}:${kind}-${hash}`;

  // Read and base64 encode the requirement file
  const fileContent = await fs.readFile(requirementFile, "utf-8");
  const base64File = Buffer.from(fileContent).toString("base64");

  // Prepare build request
  const buildRequest = {
    source: sourceImage,
    target: targetImage,
    kind: kind,
    file: base64File,
  };

  // Send build request to admin API
  const buildUrl = `${apiHost}/system/api/v1/build/start`;
  console.log(`📡 Sending build request to ${buildUrl}`);

  try {
    const response = await fetch(buildUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(authToken).toString("base64")}`,
      },
      body: JSON.stringify(buildRequest),
    });

    if (response.status === 200) {
      const result = await response.json();
      const jobName = result.data?.job_name || 'unknown';
      const jobId = result.data?.id || 'unknown';

      console.log(`✅ Build started successfully for ${kind}`);
      console.log(`🏗️ Kubernetes job: ${jobName} (ID: ${jobId})`);

      // Save the hash to cache
      await saveCachedImageHash(kind, hash);

      return hash;
    } else {
      const errorText = await response.text();
      console.error(`❌ Build failed with status ${response.status}: ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error sending build request: ${error.message}`);
    return null;
  }
}

/**
 * Get the built image tag for a language kind
 * @param {string} kind - Language kind
 * @returns {Promise<string|null>} - Image tag in format "user:kind-hash" or null
 */
export async function getBuiltImageTag(kind) {
  const hash = await loadCachedImageHash(kind);
  if (hash) {
    const username = getUsername();
    return `${username}:${kind}-${hash}`;
  }
  return null;
}

/**
 * Scan for requirement files in the packages directory and build images
 * @returns {Promise<void>}
 */
export async function scanAndBuildImages() {
  const topLevelFiles = [
    "requirements.txt",
    "package.json",
    "composer.json",
    "pom.xml",
    "go.mod",
    "Gemfile",
    "project.json",
  ];

  const buildPromises = [];
  const baseDir = process.env.OPS_PWD || process.cwd();
  const packagesDir = path.join(baseDir, 'packages');

  for (const file of topLevelFiles) {
    const filePath = path.join(packagesDir, file);
    try {
      await fs.access(filePath);
      console.log(`📦 Found requirement file: packages/${file}`);
      buildPromises.push(buildImage(filePath));
    } catch (error) {
      // File doesn't exist, skip
    }
  }

  if (buildPromises.length > 0) {
    await Promise.all(buildPromises);
  } else {
    console.log("ℹ️ No requirement files found in packages directory");
  }
}
