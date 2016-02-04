@showBootstrapGrowl = (message, options = {}, cleanOldGrowl = false) ->
  removeBootstrapGrowl() if cleanOldGrowl
  growlId = "growl-id-#{Random.id()}"
  options.type = (options.type or "info") + " #{growlId}"
  $item = $.bootstrapGrowl message, options
  $item.css("right", options.right) if options.right
  $item.css("left", options.left) if options.left
  $item.addClass(options.cssClass) if options.cssClass
  $item

@removeBootstrapGrowl = (delay = 0 ) ->
  if $('div.bootstrap-growl').length > 0
    if delay != 0
      setTimeout (->
        $('div.bootstrap-growl').not('.skip-removing').remove()
      ), delay
    else
      $('div.bootstrap-growl').not('.skip-removing').remove()

@showTooltipBootstrapGrowl = (message, options = {}, cleanOldGrowl) ->
  options.type = "tooltip"
  showBootstrapGrowl message, options, cleanOldGrowl



@showErrorBootstrapGrowl = (message, options = {}, cleanOldGrowl) ->
  options.type = "error"
  showBootstrapGrowl message, options, cleanOldGrowl