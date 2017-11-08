@EmailViewerHelper =
  validateEmail: ($form, test, callback) ->
    { emailBody, from, subject, recipients, campaigns, tags, date } = @getValidators $form, test
    validators = [ emailBody, from, subject, recipients, campaigns, tags, date ]
    async.each validators, (validator, next) ->
      validator.validate next
    , (err) ->
      return callback new Meteor.Error 400, err.error, { selector: err.selector } if err

      event = EmailEvents.findOne EmailViewerHelper.currentEmailEventId()
      callback null,
        _id: EmailViewerHelper.currentEmailEventId()
        from: from.getValue()
        subject: subject.getValue()
        recipients: recipients.getValue()
        campaigns: campaigns.getValue()
        tags: tags.getValue()
        html: emailBody.getValue().html
        due_date: date.getValue()
        file_ids: event.file_ids



  sendTestEmail: ($form, callback) ->
    @validateEmail $form, true, (err, emailData) ->
      return callback err if err
      Meteor.call 'sendTestEmail', emailData, (err, result) ->
        return callback null, 'Queued on Mailgun. Thank you!' if result
        callback err, result



  sendEmail: ($form, callback) ->
    @validateEmail $form, false, (err, emailData) ->
      return callback err if err
      Meteor.call "updateEmailEvent", emailData, EmailHelperShared.ACTIVE, EmailHelperShared.IN_QUEUE, (err, result) ->
        EmailViewerHelper.afterAddToQueue emailData unless err
        callback err, result



  getBaseValidator: ->
    withValidator: (response, validator) ->
      @runDependencies response, =>
        @getValue (err, value) =>
          result =
            error: err or validator value
            selector: @selector
          response result.error and result or null

    getValue: (callback) ->
      unless callback
        return @_value if @_value
        return @_value = @value() unless @value.length
      return callback null, @_value if @_value
      return callback null, @_value = @value() unless @value.length
      @value (err, value) => callback err, @_value = value

    validate: (response) -> response?()

    runDependencies: (response, callback) ->
      async.each @dependsOn or [], (validator, next) ->
        validator.validate next
      , (err) -> err and response(err) or callback()



  getValidators: ($context, test) ->
    jqueryMixin = value: -> $(@selector, $context).val().trim()
    stringToArrayMixin = value: -> EmailViewerHelper.getArrayFromString $(@selector).val().trim()


    emailBody = _.extend @getBaseValidator(),
      selector: '.note-editor'
      value: ->
        html: $('#email-edit').summernote 'code'
        isEmpty: $('#email-edit').summernote 'isEmpty'
      validate: (response) -> @withValidator response, (value) ->
        "Message content can't be empty. \nPlease enter some content into composer"  if value.isEmpty


    from = _.extend @getBaseValidator(), jqueryMixin,
      selector: '#from_address'
      validate: (response) -> @withValidator response, (value) ->
        "Incorrect From email" unless ValidationsHelper.isCorrectEmailWithRealName value


    subject = _.extend @getBaseValidator(), jqueryMixin,
      selector: '#subject'
      validate: (response) -> @withValidator response, (value) ->
        "Please input Subject" if _.isEmpty value


    recipients = _.extend @getBaseValidator(), stringToArrayMixin,
      selector: '#recipients'
      validate: (response) -> @withValidator response, (emails) ->
        return if test and _.isEmpty emails
        return "Input emails which separated by commas or spaces in Recipients" if _.isEmpty emails
        for email in emails
          unless ValidationsHelper.isCorrectEmail email
            return "Incorrect email '#{email}' in Recipients"
          if test and /(props|knotable)/i.test email
            return "Looks like you're trying to send a test email to a mailing list #{email}.
                    You can only send test emails to personal addresses."


    campaigns = _.extend @getBaseValidator(), stringToArrayMixin,
      selector: '#campaigns'
      validate: (response) -> @withValidator response, (campaigns) ->
        return 'Please input the campaign Id' if not test and _.isEmpty campaigns


    tags = _.extend @getBaseValidator(), stringToArrayMixin,
      selector: '#tags'
      validate: (response) -> @withValidator response, (tags) ->
        if not test and _.size(tags) > 3
          'Up to three unique tags are allowed per one message'


    unless test
      dateTypeSwitcher = _.extend @getBaseValidator(),
        selector: '.choose-absolute'
        value: -> $(@selector, $context).prop('checked')


      dueDate = _.extend @getBaseValidator(), jqueryMixin,
        selector: '.due-date'
        dependsOn: [ dateTypeSwitcher ]
        validate: (response) -> @withValidator response, (date) ->
          return unless dateTypeSwitcher.getValue()
          'Invalid Date' unless ValidationsHelper.isValidDate date


      dueTime = _.extend @getBaseValidator(), jqueryMixin,
        selector: '.due-time'
        dependsOn: [ dateTypeSwitcher ]
        validate: (response) -> @withValidator response, (time) ->
          return unless dateTypeSwitcher.getValue()
          'Invalid Time' unless ValidationsHelper.checkAndGetValidTimeFromInput time


      dateFromNow = _.extend @getBaseValidator(),
        selector: '.date-from-now'
        value: ->
          $ele = $(@selector, $context)
          minutes = $ele.find('select[name=Minutes]').val()
          hours = $ele.find('select[name=Hours]').val()
          days = $ele.find('select[name=Days]').val()
          moment().add({ minutes, hours, days }).toDate()


      date = _.extend @getBaseValidator(),
        dependsOn: [ dueDate, dueTime, dateFromNow, dateTypeSwitcher ]
        value: ->
          if dateTypeSwitcher.getValue()
            new Date "#{dueDate.getValue()} #{dueTime.getValue()}"
          else
            dateFromNow.getValue()
        validate: (response) -> @withValidator response, (dateValue) ->
          if dateTypeSwitcher.getValue() and moment() > moment(dateValue).subtract(2, 'minutes')
            "Please select a time greater than 2 minutes from now."
    else
      date = _.extend @getBaseValidator(),
        value: -> new Date

    { emailBody, from, subject, recipients, campaigns, tags, date }



  getCurrentEventContent: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    EmailEvents.findOne(eventId, fields: html: 1)?.html or ''




  getHtmlFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    Files.findOne email_event_id: eventId



  displayHtmlInEditor: ->
    file = @getHtmlFile()
    if file
      Meteor.call 'getFileFromS3Url', file.s3_url, (error, html) ->
        $('#email-edit').summernote('code', html)



  isValidDate: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.isValidDate(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value



  isValidTime: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.checkAndGetValidTimeFromInput(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value



  currentEmailEventId: -> Session.get "CURRENT_DRAFT_EVENT_ID"



  currentEmailEvent: ->
    eventId = @currentEmailEventId()
    if eventId
      emailEvent = EmailEvents.findOne _id : eventId
      return emailEvent
    return {}



  validDateTimeInEmailBox: ($form) ->
    $dueDate =  $form.find(".due-date")
    unless date = @isValidDate($dueDate, "Invalid Date")
      return null

    $dueTime =  $form.find(".due-time")
    unless time = @isValidTime $dueTime, "Invalid Time"
      return null
    eventDate = new Date(date + " " + time)
    currentTime = new Date()
    next2MinutesLate = DateHelperShared.from_minutes(currentTime, 2)

    if eventDate.getTime() < next2MinutesLate.getTime()
      $dueDate.addClass "input-error"
      showErrorBootstrapGrowl "Please select time which is after 2 minutes from now."
      return null
    return eventDate



  toggleDateTimeBoxInEmailBox: ($form) ->
    $form.toggleClass('hidden')



  getArrayFromString: (emailString) ->
    unless emailString
      return null
    emails = emailString.replace( /\n/g, " " ).split(/[ ,]+/)
    return _.uniq _.compact emails



  # Add new draft EmailEvent
  # Copy content from old ones including file
  afterAddToQueue: (emailData) ->
    draftId = emailHelperShared.createDraftEmailEvent Meteor.userId(), EmailHelperShared.DRAFT,
      campaigns  : emailData.campaigns
      tags       : emailData.tags
      recipients : emailData.recipients
      from       : emailData.from
      due_date   : emailData.due_date
      subject    : emailData.subject
      html       : emailData.html
      text       : emailData.text

    newFileIds = []
    Files.find({_id: $in: emailData.file_ids}).forEach (file) ->
      delete file._id
      file.email_event_id = draftId
      file.created_time   = new Date()
      fileId = Files.insert file
      newFileIds.push fileId

    EmailEvents.update {_id: draftId}, {$set: {file_ids: newFileIds}}
    Meteor.subscribe "fileByEmailEventId", draftId
    Session.set "CURRENT_DRAFT_EVENT_ID", draftId



  resetDraftEmailEvent: ->
    Tracker.nonreactive ->
      EmailEventId = Session.get("CURRENT_DRAFT_EVENT_ID")
      fileIds = EmailEvents.findOne(EmailEventId).file_ids
      fileIds = _.union fileIds, Files.find({email_event_id: EmailEventId}).map (file) -> file._id
      EmailEvents.update {_id: EmailEventId},
        $unset:
          file_ids   : ""
          campaigns  : ""
          recipients : ""
          from       : ""
          subject    : ""
          html       : ""
          text       : ""
          tags       : ""
      fileIds?.forEach (id) ->
        Files.remove {_id: id}



  # 1. Set status to EmailHelperShared.SENT
  # 2. Update Draft EmailEvent with new Data
  # 3. Update existing files or add new
  makeNewFromQueuedOne: (emailData) ->
    EmailEvents.update {_id: emailData._id}, {$set : {status: EmailHelperShared.SENT}}

    draftId = EmailViewerHelper.currentEmailEventId()
    newFileIds = []

    # Remove old files of draft email event
    Files.find({email_event_id: draftId}).forEach (file) ->
      Files.remove {_id: file._id}

    # Add new Files from Queued one
    Files.find({_id: $in: emailData.file_ids}).forEach (file) ->
      delete file._id
      file.email_event_id = draftId
      file.created_time   = new Date()
      fileId = Files.insert file
      newFileIds.push fileId

    console.log "GC - ", emailData
    EmailEvents.update {_id: draftId},
      $set:
        campaigns  : emailData.campaigns
        recipients : emailData.recipients
        from       : emailData.from
        subject    : emailData.subject
        due_date   : emailData.due_date
        file_ids   : newFileIds
        html       : emailData.html
        text       : emailData.text
        tags       : emailData.tags



  uploadContentImage: (file, callback) ->
    uploader = new (Slingshot.Upload)('contentImageUploads')
    uploader.send file, callback
