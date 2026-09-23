export const meta = {
  apiVersion: 1,
  key: "hcai-async-image",
  name: "HCAI Async Image",
  version: "1.0.1",
  author: { name: "HCAI" },
  icon: "text:HC",
  description: { en: "Asynchronous image generation and editing via HCAI", zh: "通过 HCAI 异步生成和编辑图片" },
  baseUrl: "https://api.hctopup.com",
  models: ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"],
  fetchMode: "per_task",
  protocols: ["openai_image"],
  routes: [
    { method: "POST", path: "/hcai/v1/images/generations/async", type: "submit", decode: "generate", render: "created" },
    { method: "POST", path: "/hcai/v1/images/edits/async", type: "submit", decode: "edit", render: "created" },
    { method: "GET", path: "/hcai/v1/images/tasks/:task_id", type: "query", render: "task" },
  ],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "image", zh: "张" },
      description: { en: "Image generation or editing unit price", zh: "图片生成或编辑单价" },
    },
  },
};

// Keep aligned with relaykit/dto.MaxImageN; no provider-specific price is assumed.
const MAX_IMAGES = 128;

function imageCount(value) {
  const count = value === undefined ? 1 : value;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) throw new Error("n must be an integer between 1 and 128");
  return count;
}

function decode(ctx, action) {
  const body = ctx.body || {};
  let request;
  if (body.kind === "json" && body.value && typeof body.value === "object" && !Array.isArray(body.value)) {
    request = { ...body.value };
    delete request.files;
  } else if (body.kind === "multipart" && action === "edit") {
    request = {};
    for (const key of Object.keys(body.fields || {})) {
      const values = body.fields[key];
      if (values.length !== 1) throw new Error("Duplicate form field: " + key);
      request[key] = values[0];
    }
    if (request.n !== undefined) {
      if (!/^\d+$/.test(request.n)) throw new Error("n must be an integer between 1 and 128");
      request.n = Number(request.n);
    }
    request.files = body.files || [];
  } else {
    throw new Error("JSON body required, or multipart for image editing");
  }
  const model = ctx.model || request.model;
  if (typeof model !== "string" || !model.trim()) throw new Error("model is required");
  if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("prompt is required");
  // No nested provider parameters: a second n/batch multiplier must not bypass billing.
  if (request.parameters !== undefined || request.batch_size !== undefined) throw new Error("Use top-level n for the image count");
  if (request.stream !== undefined && request.stream !== false && request.stream !== "false") throw new Error("Streaming images is not supported");
  request.n = imageCount(request.n);
  if (request.response_format !== undefined && !["url", "b64_json"].includes(request.response_format))
    throw new Error("response_format must be url or b64_json");
  if (action === "edit" && !request.image && !request.images && !(request.files || []).some((file) => ["image", "image[]"].includes(file.field))) {
    throw new Error("An input image is required for editing");
  }
  return { kind: "submit", model, action, requestBody: request };
}

function baseURL(ctx) {
  return ctx.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function buildSubmitRequest(ctx) {
  const request = ctx.requestBody || {};
  const n = imageCount(request.n);
  if (!["generate", "edit"].includes(ctx.action)) throw new Error("Unsupported image action");
  const body = { model: ctx.upstreamModel || ctx.model, prompt: request.prompt, n, response_format: "url" };
  // Forward the OpenAI image fields without dropping explicit zero or false values.
  for (const key of [
    "size",
    "quality",
    "style",
    "background",
    "output_format",
    "output_compression",
    "moderation",
    "user",
    "image",
    "images",
    "mask",
    "input_fidelity",
  ]) {
    if (request[key] !== undefined) body[key] = request[key];
  }
  const descriptor = {
    url: baseURL(ctx) + "/v1/images/" + (ctx.action === "edit" ? "edits" : "generations") + "/async",
    method: "POST",
    headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" },
    body,
  };
  if (request.files && request.files.length) {
    descriptor.bodyType = "multipart";
    descriptor.parts = Object.keys(body).map((name) => ({ name, value: String(body[name]) }));
    for (const file of request.files) {
      if (!["image", "image[]", "mask"].includes(file.field)) throw new Error("Unsupported image file field");
      descriptor.parts.push({ name: file.field, fileRef: file.ref, filename: file.filename });
    }
    delete descriptor.body;
  }
  return descriptor;
}

export function parseSubmitResponse(_ctx, response) {
  const body = response.body || {};
  const taskId = body.task_id || body.id;
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("HCAI did not return a task ID");
  return { taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return { url: baseURL(ctx) + "/v1/images/tasks/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}

function imageResult(body) {
  const result = (body && body.result) || {};
  const entries = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  const data = entries.filter(
    (entry) => entry && ((typeof entry.url === "string" && entry.url.trim()) || (typeof entry.b64_json === "string" && entry.b64_json.trim()))
  );
  if (!data.length && body && typeof body.image_url === "string" && body.image_url.trim()) data.push({ url: body.image_url });
  const response = { data };
  if (result.usage || (body && body.usage)) response.usage = result.usage || body.usage;
  return response;
}

export function parseTaskResult(_ctx, body) {
  const status =
    { pending: "QUEUED", queued: "QUEUED", processing: "IN_PROGRESS", running: "IN_PROGRESS", completed: "SUCCESS", failed: "FAILURE", cancelled: "FAILURE" }[
      (body || {}).status
    ] || "UNKNOWN";
  if (status === "SUCCESS" && !imageResult(body).data.length) return { status: "FAILURE", reason: "HCAI completed without an image" };
  const result = { status };
  if (status === "SUCCESS") {
    result.progress = "100%";
    const first = imageResult(body).data.find((entry) => entry.url);
    if (first) result.url = first.url;
  }
  if (status === "FAILURE") result.reason = (body.error && body.error.message) || "HCAI image task failed";
  return result;
}

export function extractUsage(ctx) {
  return { image_count: imageCount((ctx.requestBody || {}).n) };
}

export function extractUsageOnComplete(_task, result, body) {
  if (result.status !== "SUCCESS") return {};
  const data = imageResult(body).data;
  // Split url/base64 entries may represent the same image; never count metadata.
  const urls = data.filter((entry) => typeof entry.url === "string" && entry.url.trim()).length;
  const encoded = data.filter((entry) => typeof entry.b64_json === "string" && entry.b64_json.trim()).length;
  const count = Math.max(urls, encoded);
  // Empty or invalid actual usage leaves the reservation intact in the host.
  return count > 0 && count <= MAX_IMAGES ? { image_count: count } : {};
}

export const native = {
  generate(ctx) {
    return decode(ctx, "generate");
  },
  edit(ctx) {
    return decode(ctx, "edit");
  },
  created(_ctx, task) {
    return { task_id: task.task_id, status: task.status };
  },
  task(_ctx, task) {
    const response = { task_id: task.task_id, status: task.status, progress: task.progress };
    if (task.status === "SUCCESS") response.result = imageResult(task.data);
    if (task.status === "FAILURE") response.error = { message: task.fail_reason || "HCAI image task failed" };
    return response;
  },
};

export const protocols = {
  openai_image: {
    decodeRequest(ctx) {
      return decode(ctx, ctx.operation === "edit" ? "edit" : "generate");
    },
    render(_ctx, task) {
      return imageResult(task.data);
    },
  },
};
