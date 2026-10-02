export class AuthenticationRequiredError extends Error {
	constructor() {
		super("A valid signed-in session is required");
		this.name = "AuthenticationRequiredError";
	}
}
