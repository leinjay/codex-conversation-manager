cmake_minimum_required(VERSION 3.16)

# Extracted from apiDemo; C++ lifecycle entry points replace the box example.
if(NOT DEFINED CMAKE_CXX_COMPILER)
    set(CMAKE_CXX_COMPILER "{{CXX_PATH_CMAKE}}" CACHE FILEPATH "C++ compiler")
endif()
project({{PROJECT_NAME}} VERSION 1.0.0 LANGUAGES CXX)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "This project targets the Linux ZW3D SDK.")
endif()

set(ZW3D_ROOT "{{ZW3D_ROOT_CMAKE}}" CACHE PATH "ZW3D installation directory")
set(ZW3D_LIBRARY_NAME "{{LIBRARY_NAME}}" CACHE STRING "Plugin library name, matching Init/Exit exports")
if(EXISTS "${ZW3D_ROOT}/files/api/inc")
    set(ZW3D_FILES "${ZW3D_ROOT}/files")
else()
    set(ZW3D_FILES "${ZW3D_ROOT}")
endif()
foreach(required api/inc/zwapi_command.h libZW3D.so)
    if(NOT EXISTS "${ZW3D_FILES}/${required}")
        message(FATAL_ERROR "Missing ${ZW3D_FILES}/${required}; set -DZW3D_ROOT=<installation directory>.")
    endif()
endforeach()

file(GLOB_RECURSE plugin_sources CONFIGURE_DEPENDS "src/*.cpp" "src/*.cxx")
add_library(${PROJECT_NAME} SHARED ${plugin_sources})
target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_17)
target_include_directories(${PROJECT_NAME} SYSTEM PRIVATE "${ZW3D_FILES}/api/inc")
target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra)
target_link_libraries(${PROJECT_NAME} PRIVATE "${ZW3D_FILES}/libZW3D.so" ${CMAKE_DL_LIBS})
target_link_options(${PROJECT_NAME} PRIVATE -Wl,--no-undefined -Wl,--allow-shlib-undefined)
set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    OUTPUT_NAME "${ZW3D_LIBRARY_NAME}"
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/plugin"
    BUILD_RPATH "${ZW3D_FILES}"
    INSTALL_RPATH "${ZW3D_FILES}"
)

# Keep apiDemo's native resource pipeline, enabled when .ui/.tcmd files exist.
file(GLOB_RECURSE resource_sources CONFIGURE_DEPENDS "resources/*.ui" "resources/*.tcmd")
if(resource_sources)
    if(NOT EXISTS "${ZW3D_FILES}/zrc")
        message(FATAL_ERROR "ZW3D resource compiler zrc not found")
    endif()
    set(resource_file "${CMAKE_BINARY_DIR}/plugin/${ZW3D_LIBRARY_NAME}.zrc")
    add_custom_command(
        OUTPUT "${resource_file}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_BINARY_DIR}/plugin"
        COMMAND "${CMAKE_COMMAND}" -E env
            "LD_LIBRARY_PATH=${ZW3D_FILES}:${ZW3D_FILES}/libqt:${ZW3D_FILES}/lib3rd:$ENV{LD_LIBRARY_PATH}"
            "QT_QPA_PLATFORM=offscreen" "QT_DEBUG_PLUGINS=0"
            "${ZW3D_FILES}/zrc" "${CMAKE_CURRENT_SOURCE_DIR}/resources" -o "${resource_file}"
        DEPENDS ${resource_sources}
        WORKING_DIRECTORY "${ZW3D_FILES}"
        VERBATIM
    )
    add_custom_target(${PROJECT_NAME}Resources ALL DEPENDS "${resource_file}")
    add_dependencies(${PROJECT_NAME} ${PROJECT_NAME}Resources)
    install(FILES "${resource_file}" DESTINATION apilibs)
endif()
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
    set(CMAKE_INSTALL_PREFIX "${CMAKE_BINARY_DIR}/install" CACHE PATH "Install directory" FORCE)
endif()
install(TARGETS ${PROJECT_NAME} LIBRARY DESTINATION apilibs)
