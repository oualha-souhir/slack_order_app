const { DefaultAzureCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");

async function getGraphClient() {
	try {
		console.log("** getGraphClient");
		const requiredEnvVars = [
			"AZURE_TENANT_ID",
			"AZURE_CLIENT_ID",
			"AZURE_CLIENT_SECRET",
			"SHAREPOINT_HOSTNAME",
			"EXCEL_TABLE_NAME",
		];
		const missingVars = requiredEnvVars.filter(
			(varName) => !process.env[varName]
		);
		if (missingVars.length > 0) {
			throw new Error(
				`Missing required environment variables: ${missingVars.join(", ")}`
			);
		}
		console.log("Environment variables:", {
			tenantId: process.env.AZURE_TENANT_ID,
			clientId: process.env.AZURE_CLIENT_ID,
			clientSecret: process.env.AZURE_CLIENT_SECRET
				? "[REDACTED]"
				: "undefined",
			sharepointHostname: process.env.SHAREPOINT_HOSTNAME,
			excelTableName: process.env.EXCEL_TABLE_NAME,
		});

		console.log("[Excel Integration] Initializing DefaultAzureCredential");
		const credential = new DefaultAzureCredential();
		console.log("[Excel Integration] Requesting Graph API token");
		const token = await credential.getToken(
			"https://graph.microsoft.com/.default"
		);
		console.log("[Excel Integration] Token obtained successfully", {
			scope: token.scope,
		});

		return Client.init({
			authProvider: (done) => {
				done(null, token.token);
			},
		});
	} catch (error) {
		console.error(
			`[Excel Integration] Graph API authentication failed: ${error.message}`
		);
		console.error(error.stack);
		throw error;
	}
}

async function getSiteId() {
	try {
		console.log("** getSiteId");
		const client = await getGraphClient();
		console.log("[Excel Integration] Making API call to get site");
		const site = await client
			.api("/sites/espaceprojets.sharepoint.com:/sites/OrderAppDB")
			.get();
		console.log("[Excel Integration] Site ID retrieved:", site.id);
		return site.id;
	} catch (error) {
		console.error("[Excel Integration] Failed to get Site ID:", error.message);
		console.error("[Excel Integration] HTTP Status Code:", error.statusCode);
		console.error(
			"[Excel Integration] Error Response Body:",
			JSON.stringify(error.body, null, 2)
		);
		throw error;
	}
}

async function getDriveId(siteId) {
	try {
		console.log("** getDriveId");
		const client = await getGraphClient();
		const drives = await client.api(`/sites/${siteId}/drives`).get();
		console.log(
			"Available drives:",
			drives.value.map((d) => ({ id: d.id, name: d.name }))
		);
		const drive = drives.value.find(
			(d) =>
				d.name === "Documents partagés" ||
				d.name === "Shared Documents" ||
				d.name === "Documents"
		);
		if (!drive) {
			throw new Error(
				"No document library found (tried 'Documents partagés', 'Shared Documents', 'Documents')"
			);
		}
		console.log("Drive ID:", drive.id);
		return drive.id;
	} catch (error) {
		console.error(`Failed to get Drive ID: ${error.message}`);
		throw error;
	}
}

module.exports = { getSiteId, getDriveId, getGraphClient };
