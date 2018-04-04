// server.js - NodeJS server for the PiThermServer project.
/*
 * Parses data from DS18B20 temperature sensor and serves as a JSON object.
 * Uses node-static module to serve a plot of current temperature (uses highcharts).
 * Should be usable for other 1wire sensors as well, but not tested
 *
 * Original author:
 * Tom Holderness 03/01/2013
 * Ref: www.cl.cam.ac.uk/freshers/raspberrypi/tutorials/temperature/
 *
 * Updated by
 * Thommy Jakobsson thommyj@gmail.com
 */

var fs = require('fs');
var sys = require('sys');
var http = require('http');
var sqlite3 = require('sqlite3');

// Use node-static module to server chart for client-side dynamic graph
var nodestatic = require('node-static');

// Setup static server for www directory
var staticServer = new nodestatic.Server("./www", {indexFile: "log.htm"});

// Setup database connection for logging
var db = new sqlite3.Database('./piTemps.db');

// Devicefile used for reading temp
var deviceFile = "unknown";
var currentTemp = NaN;

// Write a single temperature record in JSON format to database table.
function insertTemp(data) {
    // data is a javascript object
    var statement = db.prepare("INSERT INTO temperature_records VALUES (?, ?)");
    // Insert values into prepared statement
    statement.run(data.temperature_record[0].unix_time, data.temperature_record[0].celsius);
    // Execute the statement
    statement.finalize();
}

// Read current temperature from sensor
function readTemp(callback){
    fs.readFile(deviceFile, function(err, buffer) {
        var crcOk = 0;
        var temp = NaN;

        if (err) {
            console.error(err);
            process.exit(1);
        }
        // Read data from file (using fast node ASCII encoding).
        var dataRows = buffer.toString('ascii').split("\n");
        var crcRow = dataRows[0];
        var dataRow = dataRows[1];

	// Just to be sure, check that we got a string with right size,
        // it could be corrupt
        if (typeof crcRow == "string" && crcRow.length > 2) {
            // If the crc checks out we should have a "YES" in the end
            // of the first string. If its wrong the kernel will write
            // NO, but we will treat anything besides YES as an error
            crcOk = crcRow.substr(-3) == "YES";
        }

        if (typeof dataRow == "string") {

            // Extract temperature from string and divide by 1000 to give celsius
            // Temp is at the end of the second row, prepended with "t="
            temp  = parseFloat(dataRow.split("=")[1])/1000.0;

            // Round to one decimal place
            temp = Math.round(temp * 10) / 10;
        }

	// DS18b20 is 12bit 2comp, 4 of them below the radix point
	// => max = 2^7-1+1-2^-4~127.94
        // => min = -2^7=-128
        // precision can be decreased (and other family members has
        // lower precision), but its only the lower bits that change.
        // So for a sanity check this should be good enough
        // Note that anything below -55 or above 125 is out of spec for
        // the sensor, so outside that and you will probably break it =)
        if (crcOk && typeof temp == "number" && temp < 128 && temp >= -128) {
            // Add date/time to temperature
            var data = {
                temperature_record:[{
                    unix_time: Date.now(),
                    celsius: temp
                }]
            };
            currentTemp = temp;
            // Execute call back with data
            callback(data);
        } else {
            console.log("Something went wrong! Not storing data");
            console.log("temp: " + temp + "crc ok:" + crcOk);
            console.log("Raw data: ");
            console.log(buffer.toString('ascii'));
        }
    });
};

// Create a wrapper function which we'll use specifically for logging
function logTemp(interval) {
    // Call the readTemp function with the insertTemp function as output to get initial reading
    readTemp(insertTemp);
    // Set the repeat interval (milliseconds). Third argument is passed as callback function to first (i.e. readTemp(insertTemp)).
    setInterval(readTemp, interval, insertTemp);
};

// Get temperature records from database
function selectTemp(num_records, start_date, callback){
    // - Num records is an SQL filter from latest record back trough time series,
    // - start_date is the first date in the time-series required,
    // - callback is the output function
    var current_temp = db.all("SELECT * FROM (SELECT * FROM temperature_records WHERE unix_time > (strftime('%s',?)*1000) ORDER BY unix_time DESC LIMIT ?) ORDER BY unix_time;",
                start_date, num_records,
                function(err, rows){
                    if (err){
                        response.writeHead(500, { "Content-type": "text/html" });
                        response.end(err + "\n");
                        console.log('Error serving querying database. ' + err);
                        return;
                    }
                    data = {temperature_record:[rows], current:currentTemp};
                    callback(data);
                });
};

// Setup node http server
var server = http.createServer( function(request, response) {
    // Grab the URL requested by the client and parse any query options
    var url = require('url').parse(request.url, true);
    var pathfile = url.pathname;
    var query = url.query;

    // Test to see if it's a database query
    if (pathfile == '/temperature_query.json') {
        // Test to see if number of observations was specified as url query
        if (query.num_obs) {
            var num_obs = parseInt(query.num_obs);
        } else {
        // If not specified default to 20. Note use -1 in query string to get all.
            var num_obs = -1;
        }
        if (query.start_date) {
            var start_date = query.start_date;
        } else {
            var start_date = '1970-01-01T00:00';
        }
        // Send a message to console log
        console.log('Database query request from '+ request.connection.remoteAddress +' for ' + num_obs + ' records from ' + start_date+'.');
        // call selectTemp function to get data from database
        selectTemp(num_obs, start_date, function(data){
            response.writeHead(200, { "Content-type": "application/json" });
            response.end(JSON.stringify(data), "ascii");
        });
        return;
    }

    // Test to see if it's a request for current temperature
    if (pathfile == '/temperature_now.json') {
        readTemp(function(data) {
            response.writeHead(200, { "Content-type": "application/json" });
            response.end(JSON.stringify(data), "ascii");
        });
        return;
    }

    // Handler for favicon.ico requests
    if (pathfile == '/favicon.ico'){
        response.writeHead(200, {'Content-Type': 'image/x-icon'});
        response.end();

        return;
    } else {
        // Print requested file to terminal
        console.log('Request from '+ request.connection.remoteAddress +' for: ' + pathfile);

        // Serve file using node-static
        staticServer.serve(request, response, function (err, result) {
            if (err) {
                // Log the error
                sys.error("Error serving " + request.url + " - " + err.message);

                // Respond to the client
                response.writeHead(err.status, err.headers);
                response.end('Error 404 - file not found');
                return;
            }
            return;
        })
    }
});

function usageAndQuit() {
    console.log ("[--port <1-65535>] (default 8000)");
    console.log ("[--interval <1->] (minutes, default 15min)");
    process.exit(1);
}


// default, log every 15min, time in ms
var interval = (60 * 15) * 1000;
//default, use port 8000
var port = 8000;

//first argument is name of program
//so start at 1
for (i = 1; i < process.argv.length; i++) {
     var arg = process.argv[i];
     if (arg == "--port") {
        i++;
        arg = process.argv[i];
        arg = parseInt(process.argv[i]);
        if (typeof arg == "number" && arg > 0 && arg < 65536) {
            port = arg;
        } else {
            console.log("port argument wrong")
            usageAndQuit();
        }
     } else if (arg == "--interval") {
        i++;
        arg = parseInt(process.argv[i]);
        if (typeof arg == "number" && arg >= 1) {
            //in ms
            interval = 60 * arg * 1000;
        } else {
            console.log("interval argument wrong")
            usageAndQuit();
        }
    } else if (arg == "-h" || arg == "--help") {
        usageAndQuit();
    }
}

// There should be at least one temp. device and a master, so two files 
// Find one that isn't the bus master
var devices = fs.readdirSync('/sys/bus/w1/devices/')
for (i = 0; i < devices.length; i++) {
    if ( !devices[i].includes("w1_bus_master")) {
        deviceFile = '/sys/bus/w1/devices/' + devices[0] + '/w1_slave'
    }
}

if (deviceFile == "unknown") {
    sys.error('error: no w1 devices. Is w1-therm and w1-gpio loaded?')
    process.exit()
} else if (devices.length > 2) {
    console.log('warning: more than one w1 device found. Using the first')
}

console.log("using sensor " + deviceFile)

logTemp(interval, deviceFile);
console.log('Server is logging to database at ' + interval + 'ms intervals');
server.listen(port);
console.log('Server running at http://localhost:' + port);
