// Advanced run body: supply as {"code":"..."} to the run method.
// This example reads selected nodes; run is conservatively treated as a write.
return figma.currentPage.selection.map(node => ({
  id: node.id, name: node.name, width: node.width, height: node.height
}));
