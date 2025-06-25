const {
	checkPendingOrderDelays,
	checkPaymentDelays,
	checkProformaDelays,
} = require("../services/handledelay");
const { app } = require("@azure/functions");

app.timer("delayMonitoring", {
	schedule: "0 0 * * * *", // Every hour at :00 (e.g., 12:00, 1:00)
	handler: async (timer, context) => {
		context.log("Running delay monitoring1111");

		await checkPendingOrderDelays(context);
		await checkPaymentDelays(context);
		await checkProformaDelays(context);
		context.log("Running delay monitoringéééé");

		context.log("Delay monitoring completed");
	},
});
