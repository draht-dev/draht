export type RemoteServiceErrorCode =
	| "service_not_allowed"
	| "service_not_found"
	| "service_mode_mismatch"
	| "service_member_not_found"
	| "service_member_mismatch"
	| "service_instance_not_found"
	| "service_stale_instance"
	| "service_invalid_value";

export class RemoteServiceError extends Error {
	readonly code: RemoteServiceErrorCode;

	constructor(code: RemoteServiceErrorCode, message: string) {
		super(message);
		this.name = "RemoteServiceError";
		this.code = code;
	}
}
