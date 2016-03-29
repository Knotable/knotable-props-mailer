@ValidationsHelper =

  validateEmailParams: (emailEvent) ->
    try
      unless emailEvent
        throw "Invalid emailEvent"

      if emailEvent
        from = emailEvent.from
        subject = emailEvent.subject
        to = emailEvent.recipients
        fileIds = emailEvent.file_ids
        htmlText = emailEvent.htmlText

        unless _.isEmpty fileIds
          htmlFile = Files.findOne _id: fileIds[0]
          unless FileHelper.isHtmlFile(htmlFile?.name)
            throw "Invalid file type: {htmlFile}"

        unless @isCorrectEmailWithRealName(from)
          throw "Invalid from email #{from}"
        for toEmail in to
          unless @isCorrectEmail(toEmail)
            throw "Invalid to email #{toEmail.toString()}"

        unless subject
          throw "Empty subject"

        unless htmlText
          throw "Empty Plain Text"


    catch e
      console.error "Invalid Email Params:", e
      if e.stack
        console.error e.stack
      return false
    return true



  EMAIL_REGEX: /^[a-zA-Z0-9\._\-\+]+@[a-zA-Z0-9\.\-]+\.[a-zA-Z]{2,6}$/
  isCorrectEmail: (address) ->
    ValidationsHelper.EMAIL_REGEX.test(address)

  EMAIL_WITH_REAL_NAME: /^(?:([\w\s]+)\s*<(\w+)([\-+.][\w]+)*@(\w[\-\w]*\.){1,5}([A-Za-z]){2,6}>|(\w+)([\-+.][\w]+)*@(\w[\-\w]*\.){1,5}([A-Za-z]){2,6})$/
  isCorrectEmailWithRealName: (address) ->
    ValidationsHelper.EMAIL_WITH_REAL_NAME.test(address)

  MAILING_LIST_NAME_REGEX: /^[A-Za-z0-9 _]*[A-Za-z0-9][A-Za-z0-9 _]*$/
  isValidMailingListName: (MAILING_LIST_NAME_REGEX) ->
    ValidationsHelper.MAILING_LIST_NAME_REGEX.test(MAILING_LIST_NAME_REGEX)



  isValidDate: (dateString) ->
    patt = /\d{1,2}\/\d{1,2}\/\d{4}/g
    if (patt.test(dateString))
      bits = dateString.split('/')
      d = new Date(bits[2], bits[0] - 1, bits[1])
      d && (d.getMonth() + 1) == Number(bits[0]) && d.getDate() == Number(bits[1])
    else
      false

  checkAndGetValidTimeFromInput: (inputTime) ->
    timeValid = ""
    #Check 12 time format
    regexFor12time = /^(([0]?\d|[1][0-2])(:?)([0-5]\d))\s?(a[.]?[M]?[.]?|p[.]?[M]?[.]?)$/i
    if (regexFor12time.test(inputTime))
      match = regexFor12time.exec(inputTime)
      hours = match[2]
      minutes = match[4]
      ampm = match[5]
      ampm = ampm.replace(/[.]/g, "")
      if ampm.length == 1
        ampm = ampm + 'm'
      timeValid = hours + ':' + minutes + ' ' + ampm
    else
      #Check 24 time format HH:mm
      regexFor24time = /^(([0]?\d|[1]\d|[2][0-3])(:?)([0-5]\d))\s?$/i
      if (regexFor24time.test(inputTime))
        match = regexFor24time.exec(inputTime)
        hours = match[2]
        minutes = match[4]
        timeValid = hours + ':' + minutes
    return timeValid


