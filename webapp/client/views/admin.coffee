Template.admin.domains = -> Meteor.settings.public.domains

Template.admin.rendered = -> 
  Session.set 'selected_domain', 'dev.knotable.com'
  $("#admin_frame").height $(window).height() - $(".navbar-knotable").height()
  UiHelper.showLoading()

Template.admin.domain = ->
  "http://" + Session.get('selected_domain') + "/admin/master"

Template.admin.events
  'load #admin_frame' : (e) ->
    UiHelper.hideLoading()