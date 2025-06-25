const { handleOrderSlackApi } = require("../Handlers/orderSlackApi");
const { app } = require("@azure/functions");
require("../database/config/database");

app.http("orderSlackApi", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: async (request, context) => {
		try {
			console.log("** orderSlackApi");
			console.log("⚡ Order Management System is running!");
			
			return await handleOrderSlackApi(request, context);
		} catch (error) {
			context.log(`❌ Erreur interne : ${error}`);
			return { status: 500, body: "Erreur interne du serveur" };
		}
	},
});
