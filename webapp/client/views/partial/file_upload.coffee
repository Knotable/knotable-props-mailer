Template.file_upload.onRendered ->
  $form = $(@find '.file_upload_s3')
  Meteor.defer ->
    $form.fileupload
      add: (event, data) ->
        file = data.files[0]
        FileHelper.readHtmlContentFromFile file, (err, html) ->
          return showErrorBootstrapGrowl err if err
          $('#email-edit').summernote 'code', html
