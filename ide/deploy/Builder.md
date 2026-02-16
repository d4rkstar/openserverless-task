# Builder Feature - Implementation Complete

Builder feature for custom runtime images, activated by:
- `ops ide deploy` - Full project deploy with image building
- `ops ide devel` - Watch mode with auto-rebuild on requirement changes
- `ops ide deploy --single <action>` - Single action deploy with image building

Scans `packages/` directory for requirement files, computes hash, and builds custom images via admin API.

The builder documentation is here:
https://github.com/apache/openserverless-admin-api/blob/main/docs/DEPLOYER.md

```json
{
    "source": "<source runtime image>", 
    "target": "<target image tag>", 
    "kind": "{{.KIND}}", 
    "file": "{{.REQUIREMENTS}}" 
}
```

**Parameters:**
- `source` - From `$OPS_ROOT/runtimes.json`, default runtime for language
- `target` - Format: `user:kind-hash`
  - `user`: From `$OPSDEV_USERNAME` env var (required, fails if unset)
  - `hash`: MD5 of requirement file
  - Example: `devel:python-77aedded8c2be5463dbe4b23176abd92`
- `kind` - Language from requirement file (see table below)
- `file` - Base64-encoded requirement file content

Supported requirements file are:

| language (`kind`) | requirements file |
|-------------------|-------------------|
| python            | requirements.txt  |
| nodejs            | package.json      |
| php               | composer.json     |
| java              | pom.xml           |
| go                | go.mod            |
| ruby              | Gemfile           |
| dotnet            | project.json      |

The reference endpoint is: `/system/api/v1/build/start`.
When sending a POST to the endpoint, the request can be authenticated using the
the wsk token in an authorization header. The token will be 
used to check the user (the target image hash needs to be always in the format 
`user:image-tag`).

The auth token can be extracted using the command:
`ops -wsk property get --auth`

The output will be something like:
`whisk auth		d97403a8-c1aa-49b3-ad5a-50b380ec3ab1:8YpXsnlSBrqWydMRQd4AuOMQ57obmczwi0fAWQlewbGjKhqMxeSRJ24RdsKGefrl`
remove `whisk auth` the auth token will be `d97403a8-c1aa-49b3-ad5a-50b380ec3ab1:8YpXsnlSBrqWydMRQd4AuOMQ57obmczwi0fAWQlewbGjKhqMxeSRJ24RdsKGefrl`

**API Response (200):**
```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "job_name": "build-myuser-abc123"
  },
  "message": "Build process initiated successfully"
}
```

## Build Cache

Hashes stored in `.ops/image.<kind>` (e.g., `.ops/image.python`)
- Computed: MD5 hash of current requirement file
- Cached: Hash from last successful build
- Rebuild triggered when: `computed !== cached`

## Docker Auto Replacement

Actions with `--docker auto` in comments:
```python
# --docker auto
def main(args):
    import requests
    return {}
```

**Processing:**
1. Detect language from file extension
2. Check `.ops/image.<kind>` for cached hash
3. If no cache, trigger build from `packages/<requirement-file>`
4. Replace: `--docker auto` → `--docker 127.0.0.1:32000/<user>:<kind>-<hash>`
5. Example: `--docker 127.0.0.1:32000/devel:python-77aedded8c2be5463dbe4b23176abd92`

## Environment Variables

- `OPSDEV_USERNAME` - **Required**, deployment fails if unset
- `OPS_ROOT` - Path to runtimes.json
- `OPS_PWD` - Working directory

## Implementation Files

- `builder.js` - Core build logic, API calls, cache management
- `scan.js` - Calls `scanAndBuildImages()` during full deploy
- `watch.js` - Watches `packages/*.txt|.json|etc` for changes
- `deploy.js` - Handles `--docker auto` replacement, on-demand builds
- `index.js` - Calls `scanAndBuildImages()` for `--single` flag

