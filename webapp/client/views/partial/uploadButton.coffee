@UploadButton = ->
  ui = $.summernote.ui
  button = ui.button
    contents: '<i class="fa fa-upload"/> Upload HTML'
    tooltip: 'Upload HTML Content'
    click: ->
      $('.file_upload_s3 input.upload-photo-btn-large.upload-file-input-html').click()
  button.render()
