import { App, TerraformStack } from "cdktf";
import type { Construct } from "constructs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Environment variable "${name}" is required by generated Terraform configuration`);
  }
  return value;
}

const TERRAFORM_REQUIRED_PROVIDERS = {
  "cloudflare": {
    "source": "cloudflare/cloudflare"
  }
};
const TERRAFORM_PROVIDER_CONFIGURATION = {
  "cloudflare": {}
};
const TERRAFORM_MANAGED_RESOURCES = {
  "cloudflare_dns_record": {
    "record": {
      "content": "1.2.3.4",
      "name": "www.example.com",
      "type": "A",
      "zone_id": "${cloudflare_zone.zone.zone_id}"
    }
  },
  "cloudflare_zone": {
    "zone": {
      "name": "example.com",
      "zone_id": "auto-generated"
    }
  }
};
const TERRAFORM_DATA_SOURCES = {};

class RefTokenStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.addOverride("terraform", {
      required_providers: TERRAFORM_REQUIRED_PROVIDERS,
    });

    if (Object.keys(TERRAFORM_PROVIDER_CONFIGURATION).length > 0) {
      this.addOverride("provider", TERRAFORM_PROVIDER_CONFIGURATION);
    }

    if (Object.keys(TERRAFORM_MANAGED_RESOURCES).length > 0) {
      this.addOverride("resource", TERRAFORM_MANAGED_RESOURCES);
    }

    if (Object.keys(TERRAFORM_DATA_SOURCES).length > 0) {
      this.addOverride("data", TERRAFORM_DATA_SOURCES);
    }
  }
}

const app = new App();
new RefTokenStack(app, "ref_token");
app.synth();
