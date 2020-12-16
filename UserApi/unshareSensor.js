const gatewayHelper = require('../Helpers/gatewayHelper');
const auth = require('../Helpers/authHelper');
const validator = require('../Helpers/validator');
const userHelper = require('../Helpers/userHelper');
const emailHelper = require('../Helpers/emailHelper');
const sqlHelper = require('../Helpers/sqlHelper');

const mysql = require('serverless-mysql')({
    config: {
        host     : process.env.DATABASE_ENDPOINT,
        database : process.env.DATABASE_NAME,
        user     : process.env.DATABASE_USERNAME,
        password : process.env.DATABASE_PASSWORD
    }
});

exports.handler = async (event, context) => {
    const user = await auth.authorizedUser(event.headers);
    if (!user) {
        return gatewayHelper.unauthorizedResponse();
    }

    const eventBody = JSON.parse(event.body);

    if (!eventBody || !validator.hasKeys(eventBody, ['sensor', 'user'])) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Missing sensor or e-mail.");
    }

    const sensor = eventBody.sensor;
    const targetUserEmail = eventBody.user;

    // Required when owner of the sensor
    if (targetUserEmail && !validator.validateEmail(targetUserEmail)) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Invalid E-mail given.");
    }

    if (!validator.validateMacAddress(sensor)) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Invalid sensor ID given.");
    }

    let results = null;

    try {
        let targetUser = null;
        let targetUserId = null;

        if (targetUserEmail) {
            targetUser = await userHelper.getByEmail(targetUserEmail);
            if (!targetUser) {
                return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.NOT_FOUND, "User not found.");
            }
            targetUserId = targetUser.id;
        }

        // Fetch sensor for owner information
        const ownerInfo = await sqlHelper.fetchSingle('sensor_id', sensor, 'sensors');
        if (ownerInfo === null) {
            console.log("Error fetching sensor: " + sensor);
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.NOT_FOUND, "Sensor not found.");
        }

        const owner = ownerInfo.owner_id;
        let wasRemoved = false;

        if (targetUser !== null && user.id === owner) {
            // Remove sensor you shared
            results = await mysql.query({
                sql: `DELETE sensor_profiles
                    FROM sensor_profiles
                    INNER JOIN sensors ON sensors.sensor_id = sensor_profiles.sensor_id
                    WHERE
                        sensor_profiles.user_id = ?
                        AND sensor_profiles.is_active = 1
                        AND sensors.owner_id = ?
                        AND sensors.owner_id != ?
                        AND sensors.sensor_id = ?`,
                timeout: 1000,
                values: [targetUserId, user.id, targetUserId, sensor]
            });

            wasRemoved = results.affectedRows >= 1;

            if (wasRemoved) {
                // Success
                console.log(`User ${user.id} unshared sensor ${sensor} from ${targetUserId}`);
                await emailHelper.sendShareRemovedNotification(
                    targetUserEmail,
                    sensor, // We probably want to fetch the localized sensor name for this
                    user.email,
                    process.env.SOURCE_EMAIL,
                    process.env.SOURCE_DOMAIN
                );
            }
        } else {
            // Remove sensor shared to you
            results = await mysql.query({
                sql: `DELETE sensor_profiles
                    FROM sensor_profiles
                    INNER JOIN sensors ON sensors.sensor_id = sensor_profiles.sensor_id
                    WHERE
                        sensor_profiles.user_id = ?
                        AND sensor_profiles.is_active = 1
                        AND sensors.owner_id = ?
                        AND sensors.owner_id != ?
                        AND sensors.sensor_id = ?`,
                timeout: 1000,
                values: [user.id, owner, user.id, sensor]
            });

            wasRemoved = results.affectedRows >= 1;

            if (wasRemoved) {
                // Success
                const ownerUser = await sqlHelper.fetchSingle('id', owner, 'users');
                if (ownerUser === null) {
                    return gatewayHelper.errorResponse(gatew.HTTPCodes.INVALID, "Error sending notification to owner.");
                }

                console.log(`User ${user.email} (${user.id}) unshared sensor ${sensor} from ${ownerUser.email} (${owner})`);
                let emailResult = await emailHelper.sendShareRemovedNotification(
                    ownerUser.email,
                    sensor, // We probably want to fetch the localized sensor name for this
                    user.email,
                    process.env.SOURCE_EMAIL,
                    process.env.SOURCE_DOMAIN
                );
            }
        }

        if (!wasRemoved) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "No access to sensor or sensor not shared.");
        }

        // Run clean up function
        await mysql.end();
    } catch (e) {
        console.error(e);
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INTERNAL, "Unknown error occurred.");
    }

    return gatewayHelper.successResponse();
}
