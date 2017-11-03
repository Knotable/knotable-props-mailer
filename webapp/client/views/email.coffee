Template.new_email.onRendered ->
  lastContent = null
  $('#email-edit').summernote
    placeholder: 'Write your message here...'
    toolbar: [
      ['style', ['bold', 'italic', 'underline', 'clear']],
      ['insert', ['link', 'table', 'hr']],
      ['font', ['strikethrough', 'superscript', 'subscript']],
      ['fontsize', ['fontsize']],
      ['color', ['color']],
      ['para', ['ul', 'ol', 'paragraph']],
      ['height', ['height']],
      ['misc', ['fullscreen', 'codeview', 'undo', 'redo', 'help']]
    ]
    callbacks:
      onBlur: ->
        content = $('#email-edit').summernote 'code'
        return if content is lastContent
        lastContent = content
        EmailViewerHelper.writeContentIntoFile content

  @autorun ->
    $('#email-edit').summernote 'reset'
    $('#email-edit').summernote 'code', EmailViewerHelper.getCurrentEventContent()
    lastContent = $('#email-edit').summernote 'code'
  unless EmailViewerHelper.currentEmailEventId()
    Meteor.call "findAndCreateIfNotExistingDraftEmail", (e, eventId) ->
      Session.set "CURRENT_DRAFT_EVENT_ID", eventId



Template.new_email.helpers
  hasUploadedFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      false
    plainTextfile = Files.findOne email_event_id: eventId, extension: FileHelper.PLAIN_TEXT_TYPE
    htmlfile = Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE
    return true if plainTextfile and htmlfile
    return false



  draftEvent: ->
    EmailEvents.findOne _id : EmailViewerHelper.currentEmailEventId()



  htmlFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      return false
    Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE




Template.new_email.events
  'click .btn-send': (e) ->
    e.stopPropagation()
    $ele = $(e.currentTarget)
    $form = $ele.closest('.email-container')
    $(".input-error").removeClass 'input-error'
    $('.btn-send', $form).attr('disabled', 'disabled')
    EmailViewerHelper.sendEmail $form, (err, result) ->
      $('.btn-send', $form).removeAttr('disabled')
      if err
        { selector } = err.details or {}
        showErrorBootstrapGrowl err.reason
        $(selector, $form).addClass('input-error').focus() if selector
      else
        $('a[href="#tab-queued"]').click()
        showBootstrapGrowl("Added email in queue")



  'click .btn-test-send': (e) ->
    e.stopPropagation()
    $ele = $(e.currentTarget)
    originalText = $ele.text()
    $ele.text('Sending')
    $form = $ele.closest('.email-container')
    $(".input-error").removeClass 'input-error'
    EmailViewerHelper.sendTestEmail $form, (err, result) ->
      $ele.text(originalText)
      if err
        { selector } = err.details or {}
        showErrorBootstrapGrowl err.reason
        $(selector, $form).addClass('input-error').focus() if selector
      else
        showBootstrapGrowl result



  "click .reset": (e) ->
    $ele = $(e.currentTarget)
    $form = $ele.closest('.email-container')
    EmailViewerHelper.resetDraftEmailEvent()
    reset_new_email_event_form $form



  "click .btn-select-file-html": ->
    $('.file_upload_s3 input.upload-photo-btn-large.upload-file-input-html').click()



  "click .delete-file-html": (e) ->
    isOk = confirm("Do you want remove this file?")
    if isOk
      fileId = $(e.currentTarget).attr('data-id')
      Files.remove _id : fileId
      console.info "Remove file with id:", fileId



reset_new_email_event_form = ($form) ->
  $form.find("input[type=text]").val("")
  $dueTime = $form.find(".due-time")
  $dueDate =$form.find(".due-date-picker")
  next5MinutesTime =  DateHelperShared.from_minutes(new Date(), 5)
  $dueDate.datepicker 'setDate', next5MinutesTime
  $dueTime.timepicker 'setTime', next5MinutesTime
  $form.find('.test-email').removeAttr('checked')
  $form.find('.event-plain-text').val('')



Template.email_list.helpers
  email_events : ->
    currentDate = new Date()
    query =
      status : EmailHelperShared.IN_QUEUE
      type: EmailHelperShared.ACTIVE
      due_date:
        $gte : currentDate
    email_events = EmailEvents.find(query).fetch()
    return email_events



Template.sent_email_list.helpers
  sent_email_events : ->
    currentDate = new Date()
    query =
      status: EmailHelperShared.SENT
      type: EmailHelperShared.ACTIVE
    email_sent_events = EmailEvents.find(query, {sort: {due_date: -1 }}).fetch()
    return email_sent_events



Template.email_box.helpers
  plainTextFile : ->
    file = Files.findOne email_event_id : @_id, extension: FileHelper.PLAIN_TEXT_TYPE
    return false unless file
    return file

  htmlFile : ->
    file = Files.findOne @file_ids?[0]
    return false unless file
    return file



  date: ->
    return moment(@due_date).format("MMM D YYYY, h:m A")



  timeFromNow: ->
    timeTick.depend()
    return DateHelperShared.getCountDown @due_date



Template.email_box.events
  'click .email-box-badge-delete': (e) ->
    eventId = $(e.currentTarget).data("id")
    isOk = confirm("Do you really want to delete it?")
    if isOk and eventId
      Meteor.call "removeEmailEvent", eventId, (e, result) ->
        if e
          console.log e
        else
          console.log "Removed email_event with id #{eventId} "



  'click .edit-email-event': (e) ->
    $form = $(e.target).closest('.email-box').find('.email-box-change-date')
    EmailViewerHelper.toggleDateTimeBoxInEmailBox($form)



  'click .save-update-date': (e) ->
    $form = $(e.target).closest('.email-box')
    $changeDateForm = $form.find('.email-box-change-date')
    if eventDate = EmailViewerHelper.validDateTimeInEmailBox($changeDateForm)
      eventId = $form.data("id")
      emailHelperShared.updateDateOfEmailEvent eventId, eventDate
      EmailViewerHelper.toggleDateTimeBoxInEmailBox($changeDateForm)



  'click .cancel-update-date': (e) ->
    $form = $(e.target).closest('.email-box').find('.email-box-change-date')
    EmailViewerHelper.toggleDateTimeBoxInEmailBox($form)


  'click .make-new': ->
    self =  @
    EmailViewerHelper.resetDraftEmailEvent()
    Meteor.defer ->
      EmailViewerHelper.makeNewFromQueuedOne self



Template.file_attachment_box.helpers
  file_ext: ->
    dotIndex = @name.lastIndexOf(".")
    if(dotIndex>=0)
      file_ext = @name.substr(dotIndex+1).toLowerCase()
    else
      file_ext = ""
    file_ext


Template.sent_email_box.helpers
  displayDate: (date) ->
    moment(date).format("MMM D YYYY, h:m A")


  joinArray: (array) ->
    return array.join(', ')


  file: ->
    Files.findOne(@file_ids?[0])
