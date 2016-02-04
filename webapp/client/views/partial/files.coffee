Template.file_box.helpers
  short_name: ->
    FileHelper.getShortFileName(@name)



  transform: ->
    if this.transform == undefined
      return
    if this.transform == 0
      return 'one'
    else if this.transform == 90
      return 'two'
    else if this.transform ==180
      return 'three'
    else
      return 'four'



  readable_size: ->
    FileHelper.fileSize2Text(@size)



  is_image: ->
    if @type
      @type.indexOf('image') != -1 # mime type start with image



  file_ext: ->
    dotIndex = @name.lastIndexOf(".")
    if(dotIndex>=0)
      file_ext = @name.substr(dotIndex+1).toLowerCase()
    else
      file_ext = ""
    file_ext




Template.file_box.events
  'click .delete_file_ico': (e) ->
    e.stopPropagation()
    fileId = $(this).attr("_id")
    isOk = confirm("Do you want remove this file?")
    if isOk
      Files.remove _id : fileId
      console.info "Remove file with id:", fileId




Template.file_box.rendered = ->
  file_s3_url = @data.s3_url
  # Show loading until thumbs load
  $(this.find("img.thumb")).hide().after('<img class="loading" src="/images/loading.gif" />')
  $(this.find("img.thumb")).load ->
    $(this).show()
    $(this).next("img.loading").remove()
