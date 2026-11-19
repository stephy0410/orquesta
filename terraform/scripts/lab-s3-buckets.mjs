#!/usr/bin/env node
/**
 * Crea o destruye los buckets S3 de assets e imports vía AWS CLI en AWS Academy Learner Lab,
 * donde la SCP niega s3:GetBucketObjectLockConfiguration y el provider aws de Terraform falla
 * al leer/crear recursos aws_s3_bucket.
 */
import { execFileSync } from "node:child_process";

function runAws(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      stderr: "",
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || err.message || ""),
    };
  }
}

function ensureBucket(bucket, region) {
  const head = runAws(["s3api", "head-bucket", "--bucket", bucket, "--region", region]);
  if (head.ok) {
    console.log(`Bucket ${bucket} already exists.`);
    return;
  }
  const createArgs = ["s3api", "create-bucket", "--bucket", bucket, "--region", region];
  if (region !== "us-east-1") {
    createArgs.push("--create-bucket-configuration", `LocationConstraint=${region}`);
  }
  const created = runAws(createArgs);
  if (!created.ok && !created.stderr.includes("BucketAlreadyOwnedByYou")) {
    throw new Error(`Failed to create bucket ${bucket}: ${created.stderr}`);
  }
  console.log(`Bucket ${bucket} ready in ${region}.`);
}

function destroyBucket(bucket, region) {
  const res = runAws(["s3", "rb", `s3://${bucket}`, "--force", "--region", region]);
  if (!res.ok) {
    if (res.stderr.includes("NoSuchBucket")) {
      console.log(`Bucket ${bucket} already absent.`);
      return;
    }
    throw new Error(`Failed to delete bucket ${bucket}: ${res.stderr}`);
  }
  console.log(`Bucket ${bucket} deleted.`);
}

const [action, assetsBucket, importsBucket, region = "us-east-1"] = process.argv.slice(2);
if (!action || !assetsBucket || !importsBucket || !["create", "destroy"].includes(action)) {
  console.error("Usage: node lab-s3-buckets.mjs <create|destroy> <assets_bucket> <imports_bucket> [region]");
  process.exit(1);
}

for (const bucket of [assetsBucket, importsBucket]) {
  if (action === "create") {
    ensureBucket(bucket, region);
  } else {
    destroyBucket(bucket, region);
  }
}
