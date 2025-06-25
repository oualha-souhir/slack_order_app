const dotenv = require('dotenv');
const { getGraphClient, getSiteId,getDriveId } = require('../ExcelIntegration/ExcelConfig');
dotenv.config(); // Load environment variables

async function syncCaisseToExcel(caisse, requestId) {
	console.log("** syncCaisseToExcel");
	const maxRetries = 3;
	for (let i = 0; i < maxRetries; i++) {
		try {
			const client = await getGraphClient();
			const siteId = await getSiteId();
			const driveId = await getDriveId(siteId);
			const fileId = process.env.CAISSE_EXCEL_FILE_ID;
			const tableName = "CaisseTable";

			const request = caisse.fundingRequests.find(
				(r) => r.requestId === requestId
			);
			if (!request) throw new Error(`Funding request ${requestId} not found`);
			// Prepare cheque details as a single string (if applicable)
			let paymentDetailsString = "";
			if (
				request.paymentDetails?.method &&
				["cheque", "Chèque"].includes(request.paymentDetails.method) &&
				request.paymentDetails.cheque
			) {
				const cheque = request.paymentDetails.cheque;
				const fields = [
					cheque.number ? `- Numéro du chèque: ${cheque.number}` : null,
					cheque.bank ? `- Banque: ${cheque.bank}` : null,
					cheque.date ? `- Date du chèque: ${cheque.date}` : null,
					cheque.order ? `- Ordre: ${cheque.order}` : null,
				];
				// Add file IDs information
				if (cheque.file_ids && cheque.file_ids.length > 0) {
					fields.push(
						`- Fichiers: ${cheque.file_ids.length} fichier(s) associé(s)`
					);
					// Optionally include file URLs (truncated)
					fields.push(
						`- Liens des fichiers:\n${cheque.file_ids
							.map((url) => `- ${truncate(url, 50)}`)
							.join("\n")}`
					);
				}

				// Add URLs information
				if (cheque.urls && cheque.urls.length > 0) {
					fields.push(`- URLs: ${cheque.urls.join(", ")}`);
				}
				paymentDetailsString = fields.filter(Boolean).join("\n");
			}

			const rowData = [
				request.requestId, // Request ID
				request.amount || 0, // Amount
				request.currency || "XOF", // Currency
				request.reason || "", // Reason
				request.status || "En attente", // Status
				request.rejectionReason || "", // Status

				new Date(request.requestedDate).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
				}) || new Date().toISOString(), // Date requise (same as Requested Date)
				request.submittedBy || "", // Submitted By
				request.submittedAt
					? new Date(request.submittedAt).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							timeZoneName: "short",
					  })
					: "", // Submitted At
				request.approvedBy || "", // Approved By
				request.approvedAt
					? new Date(request.approvedAt).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							timeZoneName: "short",
					  })
					: "", // Approved At

				request.paymentDetails.notes || "", // Notes
				request.disbursementType || "", // Disbursement Type
				paymentDetailsString || "", // 15: Détails de Paiement
				caisse.balances.XOF || 0, // Balance XOF
				caisse.balances.USD || 0, // Balance USD
				caisse.balances.EUR || 0, // Balance EUR
				"Yes", // Latest Update
			];
			console.log(
				`[Excel Integration] Updating row for request ${requestId} with data:`,
				JSON.stringify(rowData, null, 2)
			);
			// Fetch all rows to find the current and previous latest rows
			console.log(
				"[Excel Integration] Fetching table rows for requestId:",
				requestId
			);
			const tableRows = await client
				.api(
					`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
				)
				.get();

			// Fetch table columns
			const tableColumns = await client
				.api(
					`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/columns`
				)
				.get();
			const columnCount = tableColumns.value.length;

			// Validate rowData length
			if (rowData.length !== columnCount) {
				console.error(
					`[Excel Integration] Error: rowData has ${rowData.length} columns, but table expects ${columnCount}`
				);
				throw new Error(
					"Column count mismatch between rowData and table structure"
				);
			}
			let rowIndex = -1;
			let previousLatestIndex = -1;
			if (tableRows && tableRows.value) {
				rowIndex = tableRows.value.findIndex(
					(row) => row.values && row.values[0] && row.values[0][0] === requestId // Adjusted index: Request ID is now at 0
				);
				if (caisse.latestRequestId && caisse.latestRequestId !== requestId) {
					previousLatestIndex = tableRows.value.findIndex(
						(row) =>
							row.values &&
							row.values[0] &&
							row.values[0][0] === caisse.latestRequestId
					);
				}
			}

			// Update previous latest row to "No" (if it exists)
			if (previousLatestIndex >= 0 && previousLatestIndex !== rowIndex) {
				const previousRowValues =
					tableRows.value[previousLatestIndex].values[0];
				if (previousRowValues.length >= 15) {
					// Adjusted for 15 columns
					previousRowValues[17] = " "; // Adjusted index: Latest Update is now at 14
					console.log(
						"[Excel Integration] Updating previous latest row to 'No':",
						caisse.latestRequestId
					);
					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${previousLatestIndex})`
						)
						.patch({ values: [previousRowValues] });
				}
			}

			// Update or add the current row
			if (rowIndex >= 0) {
				console.log(
					"[Excel Integration] Updating existing row for requestId:",
					requestId
				);
				await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${rowIndex})`
					)
					.patch({ values: [rowData] });
			} else {
				console.log(
					"[Excel Integration] Adding new row for requestId:",
					requestId
				);
				await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
					)
					.post({ values: [rowData] });
			}

			// Update latestRequestId in the database
			caisse.latestRequestId = requestId;
			console.log(
				"[Excel Integration] Updating latestRequestId to:",
				requestId
			);
			await caisse.save();

			console.log(
				"[Excel Integration] Excel sync completed for requestId:",
				requestId
			);
			return;
		} catch (error) {
			console.error("[Excel Integration] Error in syncCaisseToExcel:", {
				message: error.message,
				stack: error.stack,
				attempt: i + 1,
				requestId,
			});
			if (i === maxRetries - 1) {
				throw new Error(`Excel sync failed: ${error.message}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}
// Helper function to truncate strings
function truncate(str, max) {
	return str.length > max ? str.slice(0, max) + "..." : str;
}
module.exports = {
	syncCaisseToExcel,
};