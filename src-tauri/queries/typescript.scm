; typescript.scm — match functions, classes, interfaces, exports
(function_declaration name: (identifier) @name) @function
(method_definition name: (property_identifier) @name) @function
(arrow_function) @function
(class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @class
(export_statement declaration: (function_declaration name: (identifier) @name)) @function
(export_statement declaration: (class_declaration name: (type_identifier) @name)) @class
