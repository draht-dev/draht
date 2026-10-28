import { afterEach, describe, expect, it } from "vitest";
import {
	ENV_BUG_REPORT_GATEWAY,
	ENV_RADIUS_GATEWAY,
	getBugReportGatewayUrl,
	getRadiusGatewayUrl,
} from "../src/core/radius.ts";

afterEach(() => {
	delete process.env[ENV_RADIUS_GATEWAY];
	delete process.env[ENV_BUG_REPORT_GATEWAY];
});

describe("getBugReportGatewayUrl", () => {
	it("defaults to radius.draht.dev", () => {
		expect(getBugReportGatewayUrl()).toBe("https://radius.draht.dev");
	});

	it("honors DRAHT_BUG_REPORT_GATEWAY", () => {
		process.env[ENV_BUG_REPORT_GATEWAY] = "https://bug-reports.example.com";
		expect(getBugReportGatewayUrl()).toBe("https://bug-reports.example.com");
	});

	it("ignores DRAHT_RADIUS_GATEWAY", () => {
		process.env[ENV_RADIUS_GATEWAY] = "https://radius.example.com";
		expect(getBugReportGatewayUrl()).toBe("https://radius.draht.dev");
	});
});

describe("getRadiusGatewayUrl", () => {
	it("defaults to radius.pi.dev", () => {
		expect(getRadiusGatewayUrl()).toBe("https://radius.pi.dev");
	});

	it("honors DRAHT_RADIUS_GATEWAY and ignores DRAHT_BUG_REPORT_GATEWAY", () => {
		process.env[ENV_RADIUS_GATEWAY] = "https://radius.example.com";
		process.env[ENV_BUG_REPORT_GATEWAY] = "https://bug-reports.example.com";
		expect(getRadiusGatewayUrl()).toBe("https://radius.example.com");
	});
});
