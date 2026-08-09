/**
 * The network policy the trust badge enforces: only same-origin or model-host requests are allowed;
 * anything else is an exfiltration signal. Getting this classifier right is what makes the badge honest.
 */
import { describe, expect, it } from "vitest";
import { isAllowedRequest, isModelHost } from "./requestPolicy";

const ORIGIN = "https://mechikon.example.com";

describe("isModelHost", () => {
  it("accepts the model/runtime hosts and their subdomains", () => {
    expect(isModelHost("huggingface.co")).toBe(true);
    expect(isModelHost("us.aws.cdn.hf.co")).toBe(true); // Xet CDN subdomain
    expect(isModelHost("cdn.jsdelivr.net")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isModelHost("evil.com")).toBe(false);
    expect(isModelHost("huggingface.co.evil.com")).toBe(false); // suffix trick
    expect(isModelHost("notjsdelivr.net")).toBe(false);
  });
});

describe("isAllowedRequest", () => {
  it("allows same-origin requests (absolute and relative)", () => {
    expect(isAllowedRequest(`${ORIGIN}/assets/app.js`, ORIGIN)).toBe(true);
    expect(isAllowedRequest("/models/x.onnx", ORIGIN)).toBe(true);
  });
  it("allows the model hosts", () => {
    expect(isAllowedRequest("https://huggingface.co/onnx-community/x/resolve/main/config.json", ORIGIN)).toBe(true);
    expect(isAllowedRequest("https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.wasm", ORIGIN)).toBe(true);
  });
  it("allows in-memory blob:/data: URLs (never leave the device)", () => {
    expect(isAllowedRequest("blob:https://mechikon.example.com/uuid", ORIGIN)).toBe(true);
    expect(isAllowedRequest("data:text/plain;base64,AAAA", ORIGIN)).toBe(true);
  });
  it("flags an off-origin, non-model host (exfiltration)", () => {
    expect(isAllowedRequest("https://evil.com/collect", ORIGIN)).toBe(false);
    expect(isAllowedRequest("https://analytics.google.com/g", ORIGIN)).toBe(false);
  });
  it("flags a non-GET request to a model host — the model path is read-only, a write is exfiltration", () => {
    const modelFile = "https://huggingface.co/onnx-community/x/resolve/main/config.json";
    expect(isAllowedRequest(modelFile, ORIGIN, "POST")).toBe(false);
    expect(isAllowedRequest(modelFile, ORIGIN, "post")).toBe(false); // fetch init.method may be lowercase
    expect(isAllowedRequest("https://us.aws.cdn.hf.co/blob", ORIGIN, "PUT")).toBe(false);
    expect(isAllowedRequest("https://cdn.jsdelivr.net/npm/x", ORIGIN, "DELETE")).toBe(false);
  });
  it("keeps GET model fetches allowed (explicit and default method)", () => {
    const modelFile = "https://huggingface.co/onnx-community/x/resolve/main/config.json";
    expect(isAllowedRequest(modelFile, ORIGIN, "GET")).toBe(true);
    expect(isAllowedRequest(modelFile, ORIGIN)).toBe(true); // method omitted defaults to GET
  });
  it("does not method-gate same-origin requests (they never leave the device)", () => {
    expect(isAllowedRequest(`${ORIGIN}/api/local`, ORIGIN, "POST")).toBe(true);
  });
  it("fails CLOSED on an unparseable URL — a crafted request must alarm, not slip through", () => {
    // Junk with no usable base (the worker's origin can be "" when it has no location).
    expect(isAllowedRequest("not a url", "")).toBe(false);
    // Absolute-but-invalid URLs that throw even with a valid base.
    expect(isAllowedRequest("https://", ORIGIN)).toBe(false);
    expect(isAllowedRequest("http://exa mple.com/x", ORIGIN)).toBe(false);
  });
});
