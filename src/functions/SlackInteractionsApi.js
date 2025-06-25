const {
	handleSlackInteractions,
} = require("../Handlers/slackInteractions");
const { app } = require("@azure/functions");

app.http("slackInteractions", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: async (request, context) => {
		try {
			console.log("** slackInteractions");
			return await handleSlackInteractions(request, context);
		} catch (error) {
			context.log(`❌ Erreur interne : ${error}`);
			return { status: 500, body: "Erreur interne du serveur" };
		}
	},
});
