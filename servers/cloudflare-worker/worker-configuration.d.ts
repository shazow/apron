import type { ApronDemoServer } from "./src/index";

declare global {
	interface Env {
		DEMO: DurableObjectNamespace<ApronDemoServer>;
		ASSETS?: Fetcher;
		ALLOWED_ORIGINS?: string;
		RP_ID?: string;
		RP_ORIGINS?: string;
		RP_NAME?: string;
		IP_HMAC_SECRET?: string;
		OPERATOR_SECRET?: string;
		ADMISSION_OFF?: string;
		ENVIRONMENT?: string;
	}
	namespace Cloudflare {
		interface Env {
			DEMO: DurableObjectNamespace<ApronDemoServer>;
			ASSETS?: Fetcher;
			ALLOWED_ORIGINS?: string;
			RP_ID?: string;
			RP_ORIGINS?: string;
			RP_NAME?: string;
			IP_HMAC_SECRET?: string;
			OPERATOR_SECRET?: string;
			ADMISSION_OFF?: string;
			ENVIRONMENT?: string;
		}
	}
}

export {};
