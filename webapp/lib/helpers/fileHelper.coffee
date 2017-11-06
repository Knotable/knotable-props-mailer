@FileHelper =
  HTML_TYPE : 'html'
  PLAIN_TEXT_TYPE : 'txt'

  # Return extention of file
  # Ex: file.pdf => return 'pdf' string
  fileExtention: (fileName) ->
    extension = ''
    if fileName and fileName.indexOf('.') > 0
      extension = fileName.split('.').pop()
      extension = extension.toLowerCase()
    return extension



  isHtmlFile: (fileName) ->
    type = @fileExtention fileName
    type is @HTML_TYPE



  isPlainTextFile: (fileName) ->
    type = @fileExtention fileName
    type is @PLAIN_TEXT_TYPE



  setTextOfHtml: (file) ->
    return unless file.type is "text/html"
    return unless window.File and window.FileReader
    eventId = Tracker.nonreactive -> EmailViewerHelper.currentEmailEventId()
    reader = new FileReader()
    reader.onload = (e) ->
      html = e.target.result
      $ele = $('<div/>').append($(html))
      $ele.find('head, title, style, script, meta').remove()
      $ele = $ele.find('body') if $ele.find('body').length
      text = $ele.text().replace(/\s\s+/g, ' ').trim()
      EmailEvents.update eventId, $set: { html, text }

    reader.readAsText file



  s3_key: (file_id, filename)->
    datePart = moment().format("YYYY-MM")
    "uploads/" + datePart + "/" + file_id + '_' + filename




  s3_url: (file_id, filename) ->
    bucket = Meteor.settings.AWS.bucket
    "//#{bucket}.s3.amazonaws.com/" + @s3_key(file_id, filename)



  contentImageKey: (fileName) ->
    datePart = moment().format "YYYY-MM"
    "uploads/#{datePart}/images/#{@cleanFileName fileName}"



  cleanFileName: (filename) ->
    filename = filename.replace(/[^a-z0-9_\.\-]/gi, '_').toLowerCase()
    filename = filename.replace(/_{2,}/g, '_')
    filename.replace(/_\./g, '.')



  getShortFileNameWithLen : (name, maxFileNameLength) ->
    dotIndex = name.lastIndexOf(".")
    if(dotIndex>=0)
      file_type_class = name.substr(dotIndex+1)
    else
      file_type_class = ""

    if(name.length > maxFileNameLength)
      short_name = name.substr(0, maxFileNameLength - file_type_class.length - 3) + "..." + file_type_class
    else
      short_name = name
    return short_name



  getShortFileName : (name) ->
    return @getShortFileNameWithLen(name, 15)



  fileSize2Text: (bytes) ->
    if !bytes
      return '0 B'
    thresh = 1024
    if bytes < thresh
      return bytes + ' B';
    units = ['kB','MB','GB','TB','PB','EB','ZB','YB']
    u = -1
    loop
      bytes /= thresh;
      ++u;
      break if bytes <= thresh || u >= 7
    return bytes.toFixed(1)+' '+units[u];
