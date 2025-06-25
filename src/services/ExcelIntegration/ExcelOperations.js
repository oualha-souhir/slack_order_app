const { getGraphClient } = require("./ExcelConfig");


async function addRowToExcel(siteId, driveId, fileId, tableName, rowValues) {
  try {
    console.log("** addRowToExcel");
    const client = await getGraphClient();
    
    await client
      .api(
        `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows/add`
      )
      .post({
        values: [rowValues],
      });
    console.log("✅ Row added successfully to the table:", tableName);
  } catch (error) {
    console.error("❌ Failed to add row:", error.message);
    throw error;
  }
}

async function findRowIndex(
  siteId,
  driveId,
  fileId,
  tableName,
  idCommande,
  retries = 3,
  delay = 1000
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log("** findRowIndex");
      const client = await getGraphClient();
      console.log(
        `[Excel Integration] Fetching rows from table: ${tableName} (Attempt ${attempt})`
      );
      const rows = await client
        .api(
          `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows`
        )
        .get();

      console.log(
        `[Excel Integration] Found ${rows.value.length} rows in table`
      );

      const rowIndex = rows.value.findIndex(
        (row) => row.values[0][0] === idCommande
      );

      if (rowIndex === -1) {
        console.log(
          `[Excel Integration] No row found for order: ${idCommande}`
        );
        if (attempt < retries) {
          console.log(`[Excel Integration] Retrying after ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }

      console.log(
        `[Excel Integration] Found row at index ${rowIndex} for order: ${idCommande}`
      );
      return rowIndex;
    } catch (error) {
      console.error(
        `[Excel Integration] Failed to find row (Attempt ${attempt}): ${error.message}`
      );
      if (attempt < retries) {
        console.log(`[Excel Integration] Retrying after ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function updateRowInExcel(
  siteId,
  driveId,
  fileId,
  tableName,
  rowIndex,
  rowValues
) {
  try {
    console.log("** updateRowInExcel");
    const client = await getGraphClient();
    console.log(
      `[Excel Integration] Updating row at index ${rowIndex} in table: ${tableName}`
    );
  //  console.log("rowValues1", rowValues);
    await client
      .api(
        `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows/itemAt(index=${rowIndex})`
      )
      .patch({
        values: [rowValues],
      });
    console.log(
      `✅ Row updated successfully at index ${rowIndex} in table: ${tableName}`
    );
  } catch (error) {
    console.error(`[Excel Integration] Failed to update row: ${error.message}`);
    throw error;
  }
}
async function verifyFile(siteId, driveId, fileId) {
  try {
    console.log("** verifyFile");
    const client = await getGraphClient();
    const file = await client
      .api(`/sites/${siteId}/drives/${driveId}/items/${fileId}`)
      .get();
    console.log("File Name:", file.name);
    return file;
  } catch (error) {
    console.error(`Failed to verify file: ${error.message}`);
    throw error;
  }
}
async function getFileId(siteId, driveId, fileName) {
    try {
        const client = await getGraphClient();
        console.log("** getFileId");
        console.log("[Excel Integration] Listing files in document library");

        // API call to list all files in the drive's root
        const files = await client
            .api(`/sites/${siteId}/drives/${driveId}/root/children`)
            .get();

        // Log all files for debugging
        console.log(
            "Files in drive:",
            files.value.map((f) => ({ name: f.name, id: f.id }))
        );

        // Find the file by name (case-insensitive)
        const file = files.value.find(
            (f) => f.name.toLowerCase() === fileName.toLowerCase()
        );

        if (!file) {
            throw new Error(`File '${fileName}' not found in document library`);
        }

        console.log(`Found file '${fileName}' with ID: ${file.id}`);
        return file.id;
    } catch (error) {
        console.error(
            `[Excel Integration] Failed to get file ID: ${error.message}`
        );
        throw error;
    }
}
module.exports = {
  addRowToExcel,
  findRowIndex,
  updateRowInExcel,
  verifyFile,
  getFileId,
};