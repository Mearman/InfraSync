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
  "aws": {
    "source": "hashicorp/aws"
  }
};
const TERRAFORM_PROVIDER_CONFIGURATION = {
  "aws": {
    "region": "us-east-1"
  }
};
const TERRAFORM_MANAGED_RESOURCES = {
  "aws_some_resource": {
    "complex_resource": {
      "list_of_objects": [
        {
          "name": "first",
          "value": 1
        },
        {
          "name": "second",
          "value": 2
        }
      ],
      "list_of_strings": [
        "a",
        "b",
        "c"
      ],
      "nested_object": {
        "deep_key": "value",
        "deeper_object": {
          "leaf_value": "found"
        }
      },
      "simple_bool": true,
      "simple_null": null,
      "simple_number": 42,
      "simple_string": "hello"
    }
  }
};
const TERRAFORM_DATA_SOURCES = {};

class NestedSpecStack extends TerraformStack {
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
new NestedSpecStack(app, "nested_spec");
app.synth();
