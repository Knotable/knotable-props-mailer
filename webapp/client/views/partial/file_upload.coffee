uploadOptions =
  'uploadingEmailTemplate':
    className: ['upload-photo-btn-container-large']


    afterInsertedAFile: (err, id, event) ->


    beforeSending: (event, data) ->
      beforeUploadFile(data.files)


    done: (event, data) ->
      afterFinishUploadFile()




getFileUploadOptions = (uploadForm) ->
  uploadOptions['uploadingEmailTemplate']




afterFinishUploadFile = ->
  currentRemainUploading = parseInt($("#uploadingItems").val())
  currentRemainUploading = currentRemainUploading - 1
  $("#uploadingItems").val(currentRemainUploading)
  if currentRemainUploading <= 0
    $("#saving_file_box").removeClass 'show'
  Meteor.subscribe "fileByEmailEventId", EmailViewerHelper.currentEmailEventId()



beforeUploadFile = (files) ->
  numFiles = files.length
  return if numFiles is 0

  currentRemain = parseInt($("#uploadingItems").val())
  $("#uploadingItems").val(numFiles + currentRemain)

  fileName = FileHelper.getShortFileName(files[0].name)
  $('.container .thumb-loading-file-name').text fileName
  $("#saving_file_box").addClass 'show'



Template.file_upload.helpers
  bucket: ->
    Meteor.settings.public.aws?.bucket


  s3_credentials: ->
    if S3Credentials.areReady()
      S3Credentials.getCredentials()


  fileUpload : ->
    {
    action : "//" + Meteor.settings.public.aws?.bucket + ".s3.amazonaws.com/"
    isS3_credentials : true
    }

  hasUploadedHtml: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      false
    file = Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE
    return true if file
    return false

  hasUploadedPlainText: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      false
    file = Files.findOne email_event_id: eventId, extension: FileHelper.PLAIN_TEXT_TYPE
    return true if file
    return false


Template.file_upload.rendered = ->
  $form = $(@find '.file_upload_s3')
  options = getFileUploadOptions $form
  return unless options

  if options.className?.length
    $form.addClass options.className.join(' ')

  options.onRendered?.call @

  $form.on 'drop', (e) ->
    return unless e.originalEvent.dataTransfer?.files.length
    e.preventDefault()
    return false

  $form.bind 'fileuploadprogress', (e , data) ->
    fileUploading = Session.get('fileUploading') or {}

    progress = data._progress
    process = progress.loaded / progress.total * 100

    fileUploading[data.file_id] = {
      process : process
      name: data.file_name
    }
    Session.set('fileUploading' , fileUploading)


  Deps.autorun ->
    if S3Credentials.areReady()
      Meteor.defer -> initFileuploader $form, options


Template.file_upload.events
  'click .btn-select-file-html': (e) ->
    e.preventDefault()
    $('.file_upload_s3 input.upload-photo-btn-large.upload-file-input-html').click()

  'click .btn-select-file-txt': (e) ->
    e.preventDefault()
    $('.file_upload_s3 input.upload-photo-btn-large.upload-file-input-txt').click()



initFileuploader = ($form, options) ->
  $form.fileupload
    autoUpload: true,


    add: (event, data) ->
      eventId = EmailViewerHelper.currentEmailEventId()
      return unless eventId

      file = data.files[0]
      fileName = FileHelper.cleanFileName file.name
      fileExt = FileHelper.fileExtention fileName
      file_id = Files.insert
        name: file.name
        account_id: Meteor.userId()
        type: file.type
        size: file.size
        extension: fileExt
        created_time: new Date()
        email_event_id: eventId


      file_key = FileHelper.s3_key(file_id, fileName)
      $form.find("input[name=key]").val(file_key)
      $form.find("input[name=Content-Type]").val(file.type)

      data.file_id = file_id
      data.file_name = fileName
      data.file_ext = fileExt

      if options.beforeSubmit?.call(@, event, data) != false
        data.submit()


    submit: options.onSubmit


    send:   options.beforeSending


    fail: (event, data) ->
      errorData =
        S3Credentials: S3Credentials.credentials
        formData:
          s3_key: $form.find("input[name=AWSAccessKeyId]").val()
          s3_policy: $form.find("input[name=policy]").val()
          s3_signature: $form.find("input[name=signature]").val()
      errorData.formDataAndRealDataComparison =
          areS3PoliciesEqual: errorData.S3Credentials?.s3_policy == errorData.formData.s3_policy
          areS3KeysEqual: errorData.S3Credentials?.s3_key == errorData.formData.s3_key
          areS3SignaturesEqual: errorData.S3Credentials?.s3_signature == errorData.formData.s3_signature

      options.failed(event, data)

      Files.remove data.file_id

      if fileUploading = Session.get('fileUploading')
        if fileUploading[data.file_id]
          delete fileUploading[data.file_id]
          Session.set('fileUploading' , fileUploading)


    done: (event, data) ->
      url = data.url + FileHelper.s3_key(data.file_id, data.file_name)
      console.log "url:", url
      url = encodeURI url
      _this = @

      Files.update data.file_id,
        $set:
          s3_url: url
      , (err, result) ->
        options.afterInsertedAFile?.call _this, err, data.file_id, event

      options.done?.call @, event, data

      if fileUploading = Session.get('fileUploading')
        if fileUploading[data.file_id]
          delete fileUploading[data.file_id]
          Session.set('fileUploading' , fileUploading)


Template.file_upload_progress.helpers
  files: ->
    if fileUploading = Session.get('fileUploading')
      _.values fileUploading
