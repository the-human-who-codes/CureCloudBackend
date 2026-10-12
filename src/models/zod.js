// The one zod instance every model imports. extendZodWithOpenApi adds .openapi() so the same schemas
// carry the metadata used to generate the OpenAPI document.
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export { z };
