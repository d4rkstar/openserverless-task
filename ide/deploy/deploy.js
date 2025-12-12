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
import { expandEnv } from "./env_utils";
import { getBuiltImageTag, buildImage } from "./builder.js";
const { parse } = await import("shell-quote");

/**
 * Get the registry host for custom images
 * @returns {string} - Registry host
 */
function getRegistryHost() {
  return "127.0.0.1:32000";
}

const MAINS = ["__main__.py", "index.js", "index.php", "main.go"];

const queue = [];
const activeDeployments = new Map();

let dryRun = false;

export function setDryRun(b) {
  dryRun = b;
}

async function exec(cmd) {
  console.log("$", cmd);
  cmd = expandEnv(cmd);
  const cmdArgs = parse(cmd).filter((arg) => typeof arg === "string");

  const proc = Bun.spawn(cmdArgs, {
    shell: true,
    env: process.env,
    cwd: process.env.OPS_PWD,
    stdio: ["inherit", "inherit", "inherit"],
  });
  await proc.exited;
}

/**
 * Determine the language kind from file extension
 * @param {string} filePath - Path to the file
 * @returns {string|null} - Language kind or null
 */
function getKindFromFile(filePath) {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);

  // Check by main file name
  if (basename === "__main__.py") return "python";
  if (basename === "index.js") return "nodejs";
  if (basename === "index.php") return "php";
  if (basename === "main.go") return "go";

  // Check by extension
  if (ext === ".py") return "python";
  if (ext === ".js") return "nodejs";
  if (ext === ".php") return "php";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".rb") return "ruby";
  if (ext === ".cs") return "dotnet";

  return null;
}

async function extractArgs(files) {
  const res = [];
  for (const file of files) {
    if (await fs.exists(file)) {
      const fileContent = await fs.readFile(file, "utf-8");
      const lines = fileContent.split("\n");
      for (const line of lines) {
        // python style comment
        if (line.match(/^#[ ]?-{1,2}[^\s-].+/)) {
          res.push(line.trim().substring(1).trim());
        }
        // js style comment
        if (line.match(/^\/\/[ ]?-{1,2}[^\s-].+/)) {
          res.push(line.trim().substring(2).trim());
        }
      }
    }
  }
  return res;
}

const packageDone = new Set();

export async function deployPackage(pkg) {
  const ppath = `packages/${pkg}.args`;
  const pargs = await extractArgs([ppath]);
  const args = pargs.join(" ");
  const cmd = `ops package update ${pkg} ${args}`;
  if (!packageDone.has(cmd)) {
    await exec(cmd);
    packageDone.add(cmd);
  }
}

export async function buildZip(pkg, action) {
  await exec(`ops ide util zip A=${pkg}/${action}`);
  return `packages/${pkg}/${action}.zip`;
}

export async function buildAction(pkg, action) {
  await exec(`ops ide util action A=${pkg}/${action}`);
  return `packages/${pkg}/${action}.zip`;
}

export async function deployAction(artifact) {
  let pkg = "",
    name = "",
    typ = "";

  if (activeDeployments.has(artifact)) {
    queue.push(artifact);
    return;
  }

  activeDeployments.set(artifact, true);
  const indexInQueue = queue.indexOf(artifact);
  if (indexInQueue > -1) {
    console.log(`⚙️ Deploying ${artifact} (from queue: ${indexInQueue})`);
  }

  try {
    const sp = artifact.split("/");
    const spData = sp[sp.length - 1].split(".");
    name = spData[0];
    typ = spData[1];
    pkg = sp[1];
  } catch(error) {
    
    console.log("❌ cannot deploy", artifact, "Error:", error.message);
    return;
  }

  await deployPackage(pkg);

  let toInspect;
  if (typ === "zip") {
    const base = artifact.slice(0, -4);
    toInspect = MAINS.map((m) => `${base}/${m}`);
  } else {
    toInspect = [artifact];
  }

  let args = await extractArgs(toInspect);

  // Check if there's a --docker auto parameter and replace it
  const dockerAutoIndex = args.findIndex(arg => arg === "--docker auto");
  if (dockerAutoIndex !== -1) {
    // Determine the language kind from the artifact
    let kind = null;

    // For zip files, check the main files inside
    if (typ === "zip") {
      for (const file of toInspect) {
        const detectedKind = getKindFromFile(file);
        if (detectedKind) {
          kind = detectedKind;
          break;
        }
      }
    } else {
      // For single files, detect from the artifact
      kind = getKindFromFile(artifact);
    }

    if (kind) {
      // Get the built image tag for this kind
      let imageTag = await getBuiltImageTag(kind);

      // If no image tag found, try to build one
      if (!imageTag) {
        console.log(`⚠️ No custom image found for ${kind}, attempting to build...`);

        // Look for requirement file in the current directory
        const requirementFiles = {
          'python': 'requirements.txt',
          'nodejs': 'package.json',
          'php': 'composer.json',
          'java': 'pom.xml',
          'go': 'go.mod',
          'ruby': 'Gemfile',
          'dotnet': 'project.json'
        };

        const reqFile = requirementFiles[kind];
        if (reqFile) {
          // Check in packages directory first, then in current working directory
          const baseDir = process.env.OPS_PWD || process.cwd();
          const reqPath = path.join(baseDir, 'packages', reqFile);

          try {
            await fs.access(reqPath);
            // File exists, build the image
            const hash = await buildImage(reqPath);
            if (hash) {
              // Get the newly built image tag
              imageTag = await getBuiltImageTag(kind);
            }
          } catch (error) {
            console.log(`⚠️ No ${reqFile} found in packages directory, cannot build custom image`);
          }
        }
      }

      if (imageTag) {
        const registryHost = getRegistryHost();
        const fullImageTag = `${registryHost}/${imageTag}`;
        console.log(`🐳 Using custom built image: ${fullImageTag}`);
        args[dockerAutoIndex] = "--docker";
        args.splice(dockerAutoIndex + 1, 0, fullImageTag);
      } else {
        console.log(`⚠️ Could not build custom image for ${kind}, using default runtime`);
        // Remove --docker auto if no custom image is available
        args.splice(dockerAutoIndex, 1);
      }
    } else {
      console.log(`⚠️ Could not detect language kind for ${artifact}`);
      // Remove --docker auto if kind cannot be detected
      args.splice(dockerAutoIndex, 1);
    }
  }

  const argsStr = args.join(" ");
  const actionName = `${pkg}/${name}`;
  await exec(`ops action update ${actionName} ${artifact} ${argsStr}`);

  activeDeployments.delete(artifact);

  if (queue.length > 0) {
    const nextArtifact = queue.shift();
    console.debug(`📦 deploying from queue artifact ${nextArtifact}`);
    await deploy(nextArtifact);
  }
}

/**
 * Deploy a `file`
 * @param file
 */
export async function deploy(file) {
  // Uncomment the lines below to test specific files
  // const file = "packages/deploy/hello.py";
  // const file = "packages/deploy/multi.zip";
  // const file = "packages/deploy/multi/__main__.py";
  // const file = "packages/deploy/multi/requirements.txt";

  const stat = await fs.stat(file);

  if (stat.isDirectory()) {
    for (const start of MAINS) {
      const sub = `${file}/${start}`;
      if (await fs.exists(sub)) {
        file = sub;
        break;
      }
    }
  }

  const sp = file.split("/");
  if (sp.length > 3) {
    await buildZip(sp[1], sp[2]);
    file = await buildAction(sp[1], sp[2]);
  }
  console.log(`Deploying ${file}`);
  await deployAction(file);
}

/**
 * Deploy a `manifest.yaml` file using `ops -wsk project`
 * @param artifact
 */
export async function deployProject(artifact) {
  if (await fs.exists(artifact)) {
    const manifestContent = await Bun.file(artifact).text();
    if (manifestContent.indexOf("packages:") !== -1) {
      await exec(`ops -wsk project deploy --manifest ${artifact}`);
    } else {
      console.log(
        `⚠️ Warning: it seems that the ${artifact} file is not a valid manifest file. Skipping`
      );
    }
  }
}
