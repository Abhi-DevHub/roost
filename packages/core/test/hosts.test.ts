import { describe, it, expect } from "vitest";
import {
  resolveHost,
  connectHost,
  LocalHost,
  UnresolvableHostError,
  UnsupportedHostKindError,
  type HostConfig,
} from "../src/index.js";

describe("resolveHost (route union)", () => {
  it("parses local", () => {
    expect(resolveHost("local")).toEqual({ kind: "local", hostId: "local" });
  });

  it("parses wsl:<distro>", () => {
    expect(resolveHost("wsl:Ubuntu")).toEqual({ kind: "wsl", hostId: "wsl:Ubuntu", distro: "Ubuntu" });
  });

  it("parses ssh:<id> against configured hosts", () => {
    const hosts: HostConfig[] = [{ id: "box", kind: "ssh", host: "1.2.3.4", user: "dev" }];
    const r = resolveHost("ssh:box", hosts);
    expect(r.kind).toBe("ssh");
    if (r.kind === "ssh") {
      expect(r.connectionId).toBe("box");
      expect(r.provider).toBeNull();
    }
  });

  it("parses runtime:<id>", () => {
    expect(resolveHost("runtime:env1")).toEqual({
      kind: "runtime",
      hostId: "runtime:env1",
      environmentId: "env1",
    });
  });

  it("throws UnresolvableHostError for unknown ids", () => {
    expect(() => resolveHost("bogus")).toThrow(UnresolvableHostError);
    expect(() => resolveHost("")).toThrow(UnresolvableHostError);
    expect(() => resolveHost("ssh:missing")).toThrow(/unknown execution host/);
  });

  it("throws for an ssh id with no matching config", () => {
    expect(() => resolveHost("ssh:nope", [{ id: "other", kind: "ssh", host: "h", user: "u" }])).toThrow(
      UnresolvableHostError,
    );
  });
});

describe("connectHost", () => {
  it("returns a LocalHost for local", () => {
    expect(connectHost("local")).toBeInstanceOf(LocalHost);
  });

  it("throws UnsupportedHostKindError for wsl/runtime", () => {
    expect(() => connectHost("wsl:Ubuntu")).toThrow(UnsupportedHostKindError);
    expect(() => connectHost("runtime:env1")).toThrow(UnsupportedHostKindError);
  });

  it("never falls back to local for an unknown ssh host", () => {
    expect(() => connectHost("ssh:nope", [])).toThrow(UnresolvableHostError);
  });

  it("returns an SshHost for a configured ssh:<id>", () => {
    const hosts: HostConfig[] = [{ id: "box", kind: "ssh", host: "h", user: "u" }];
    const host = connectHost("ssh:box", hosts);
    expect(host.kind).toBe("ssh");
  });
});
