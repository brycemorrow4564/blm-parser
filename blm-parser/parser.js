"use strict"; 

module.exports = (function() {

    
    //Module level "Global" variables 
    const fs            = require('fs'), 
          EventEmitter  = require('events'); 
    
    let doneCallback; 

/*  Define general event for propagating errors up to module user level.
    Each error passed to errEmitter will have a message property, which will generally 
    describe the location in our code in which the error was encountered, as well as an 
    error property. Which will contain the error thrown. This may sometimes contain 
    redundant information in some cases but will be able to more specifically identify error
    causes in others. On ANY error we call the done callback and pass error up to user. */
    class errorEmitter extends EventEmitter {}; 
    const errEmitter = new errorEmitter();
    errEmitter.on("error", (errorObj) => { 
        if (doneCallback) {
            //Combine custom error message with actual error message in composite error
            doneCallback(new Error(errorObj.message + errorObj.error.message)); 
        } else {
            throw new Error("ERROR: parseBlmFile method called without finishing callback"); 
        }
    }); 


    /**
     * @method validateFileHandle Validates input filePath 
     * @param {String}            fileHandle represents a path to the file we wish to parse
     * @return {boolean}          true if we have a valid file to parse, false otherwise 
     */
    function validateFileHandle(fileHandle) {
        let validationPromise = new Promise((resolve, reject) => {
            //Ensure that our fileHandle is a nonempty string.
            if  (fileHandle === undefined || typeof fileHandle !== "string" ||   
                !fileHandle.hasOwnProperty('length') || fileHandle.length === 0) {            
                resolve(false); 
            }
            //Ensure that fileHandle has '.blm' ending, and has nonzero prefix
            let splitOnFileExtension = fileHandle.split('.');
            if (splitOnFileExtension.length >= 2 && //there is a '.' somewhere in path 
                splitOnFileExtension.slice(0,-1)
                .reduce((accum, curr) => { return accum + curr; }, "").length > 0 && //nonzero prefix
                splitOnFileExtension[splitOnFileExtension.length-1].toUpperCase() === 'BLM') { //blm suffix
                resolve(true); 
            } else { resolve(false); }
        });
        validationPromise.catch(err => {
            errEmitter.emit('error', {
                "message": "ERROR: Error occurred during file handle vaidation\n", 
                "error": err
            });
        }); 
        return validationPromise; 
    }; 


    /**
     * @method streamInData Read file in via stream and return to main thread upon completion 
     * @param  {String}     fileHandle represents a path to the file we wish to parse
     * @return {String}     return parsed file in string form 
     */
    function streamInData(fileHandle) {
        let streamPromise   = new Promise((resolve, reject) => {
            let stream      = fs.createReadStream(fileHandle), 
                chunks      = [],
                fileStr;
            stream.on('error', ()      => { reject(new Error('')); });
            stream.on('data',  (chunk) => { chunks.push(chunk); }); 
            stream.on('end',   ()      => { resolve(Buffer.concat(chunks).toString()); });
        }); 
        streamPromise.catch(err => {
            errEmitter.emit('error', {
                "message": `ERROR: Error occurred when trying to read file stream at path: \"${fileHandle}\"\n`, 
                "error": err 
            }); 
        }); 
        return streamPromise; 
    };


    /**
     * @method getHeader Parse data from header section and return in object literal form 
     * @param   {String} fileStr contents of the file stringified 
     * @return  {Object} contains property value pairs extracted from header section 
     */
    function getHeader(fileStr) {
        let headerPromise = new Promise((resolve, reject) => {
            /*  Result of RegExp.prototype.exec is array with two elements. 
                The second element in this group is our target matched group */
            let headerStr   = /#HEADER#([\s\S]*?)#/m.exec(fileStr)[1],
                lines       = headerStr.split(/\n/g),  
                headerData  = lines.reduce((accumulator, current) => {
                    if (current.trim() !== '') {
                        /* if this is true we can parse a key value mapping from this line extract 
                           property and value by splitting on ':', then removing whitespace/quotes */ 
                        let [property, value] = current.trim().split(':').map(elem => {
                            return elem.trim().replace(/(^[\'\"]|[\'\"]$)/g, ''); 
                        }); 
                        accumulator[property] = value; 
                    }
                    return accumulator; 
                }, {}); 
            resolve(headerData); 
        }); 
        headerPromise.catch(err => {
            errEmitter.emit('error', {
                "message": "ERROR: Error occurred when trying to parse header section of file\n", 
                "error": err
            }); 
        }); 
        return headerPromise; 
    }; 
    

    /**
     * @method getDefinitions Parse data from definition section and return in object literal form 
     * @param {String}        fileStr contents of the file stringified 
     * @param {Object}        header contains result of getHeader() function. 
     * @return {Object}       contains property value pairs extracted from definition section 
     */
    function getDefinitions(fileStr, header) {
        let definitionsPromise = new Promise((resolve, reject) => {
            if (header === undefined || header.EOF === undefined || header.EOR === undefined) {
                reject(new Error("ERROR: Error occurred when trying to parse definition section of file. Header data incorrect")); 
            }
            /*  Result of RegExp.prototype.exec is array with two elements. 
                The second element in this group is our target matched group */
            let definitionsStr  = /#DEFINITION#([\s\S]*?)#/m.exec(fileStr)[1], 
                definitions     = definitionsStr.split(header.EOF).map(elem => { return elem.trim(); }); 
            //This splitting will capture an EOR character as final element. Remove if existent 
            if (definitions[definitions.length - 1] === header.EOR) {
                definitions = definitions.slice(0, -1); 
            }
            resolve(definitions); 
        }); 
        definitionsPromise.catch(err => {
            errEmitter.emit('error', {
                "message": "ERROR: Error occurred when trying to parse definition section of file\n", 
                "error": err
            }); 
        }); 
        return definitionsPromise; 
    }; 


    /**
     * @method getData Parse data from data section and return in object literal form. For each 
     *                 data object we parse, we use indexing to match fields in param definitions 
     *                 with values.
     * @param {String} fileStr contents of the file stringified 
     * @param {Object} header contains result of getHeader(...) function. 
     * @param  {Array} definitions contains result of getDefinitions(...) function
     * @return {Array} Our return array will contain objects, each of which represents 
     *                 the data attributes for a single property in the blm file. 
     */
    function getData(fileStr, header, definitions) {
        let dataPromise = new Promise((resolve, reject) => {
            if (header === undefined || header.EOF === undefined || header.EOR === undefined) {
                reject(new Error("ERROR: Error occurred when trying to parse data section of file. Header data undefined or incorrect")); 
            } else if (definitions === undefined) {
                reject(new Error("ERROR: Error occurred when trying to parse data section of file. Definition data undefined")); 
            }
            /*  Result of RegExp.prototype.exec is array with two elements. 
                The second element in this group is our target matched group */
            let dataStr     = /#DATA#([\s\S]*)#END#/m.exec(fileStr)[1], 
                data        = dataStr.split(header.EOR).map(elem => { return elem.trim(); }), 
                //validData includes all nonempty elements from data; 
                validData   = data.reduce((accumulator, current) => {
                    if (current.length > 0) {
                        accumulator.push(current); 
                    } 
                    return accumulator; 
                }, []), 
                dataObjects = [];  
            validData.forEach((elem) => {
                //split includes an element for empty string after final EOF delimeter. Pop off array
                let dataArr = elem.split(header.EOF).slice(0, -1);
                if (dataArr.length !== definitions.length) {
                    reject(new Error("ERROR: Error occurred when trying to parse data section of file. Data array has different length than field array"));  
                }
                //Match corresponding data with indexed fields from definitions array 
                let dataObj = dataArr.reduce((accumulator, current, currInd) => {
                    accumulator[definitions[currInd]] = current; 
                    return accumulator; 
                }, {}); 
                dataObjects.push(dataObj); 
            });
            resolve(dataObjects); 
        });
        dataPromise.catch(err => {
            errEmitter.emit('error', {
                "message": "ERROR: Error occurred when trying to parse data section of file.\n", 
                "error": err
            })
        }); 
        return dataPromise; 
    };


    async function parseBlmFile(fileHandle, finishCallback) {
        //Ensure finishCallback was passed. If so store globally so errEmitter can access
        if (finishCallback && {}.toString.call(finishCallback) === '[object Function]') {
            doneCallback = finishCallback; 
        } else {
            reject(new Error("Finish callback not included as parameter to parsing function"));
        }
        //Begin asynchronous parsing process 
        let parsePromise = new Promise(async(resolve, reject) => {
            let fileHandleIsValid = await validateFileHandle(fileHandle); 
            if (!fileHandleIsValid) {
                reject(new Error("File handle entered to module is not valid")); 
            }
            //If we reach this point we have a valid blm file so we begin read it in and begin parsing 
            let fileStr     = await streamInData(fileHandle), 
                header      = await getHeader(fileStr),  
                definitions = await getDefinitions(fileStr, header), 
                data        = await getData(fileStr, header, definitions);
            resolve(data); 
        });
        parsePromise.then(
            //on promise resolve
            (data) => {
                finishCallback(null, data); 
            },
            //on promise rejection 
            (err) => {
                errEmitter.emit({
                    "message": "ERROR: Error occurred in main thread parsing logic\n", 
                    "error": err
                }); 
            }
        )
    };

    //Single external access point for module 
    return {
        parseBlmFile: parseBlmFile
    };

}());