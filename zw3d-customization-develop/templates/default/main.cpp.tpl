#include "zwapi_command.h"
#include "zwapi_message.h"

#define PLUGIN_EXPORT extern "C" __attribute__((visibility("default")))

// Put a breakpoint here, launch with “编译并调试”, then enter ~{{PROJECT_NAME}} in ZW3D.
static void {{PROJECT_NAME}}Command()
{
    cvxMsgDisp("Hello from {{PROJECT_NAME}}!");
}

// ZW3D looks for <library filename without .so>Init/Exit, with C linkage.
PLUGIN_EXPORT int {{LIBRARY_NAME}}Init(int format, void *data)
{
    (void)format;
    (void)data;
    const auto error = ZwCommandFunctionLoad("{{PROJECT_NAME}}",
        reinterpret_cast<zwFunctionPointer>({{PROJECT_NAME}}Command), ZW_LICENSE_CODE_GENERAL);
    if (error != 0)
        return static_cast<int>(error);
    cvxMsgDisp("{{LIBRARY_NAME}} loaded. Enter ~{{PROJECT_NAME}} to run.");
    return 0;
}

PLUGIN_EXPORT int {{LIBRARY_NAME}}Exit()
{
    return static_cast<int>(ZwCommandFunctionUnload("{{PROJECT_NAME}}"));
}
