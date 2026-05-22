我现在在做一个标注任务分配的工作，目前有5个bench的题目，有24个标注员，每个标注员分配的任务我已经分配好了，在目录：
@examples/task1_allocations/task/allocations_t100_a24_r3 里，里面的每个csv文件就是一个标注员所需要标注的任务。
后续我将标注任务对应到了具体的人名上，目前的文件是：@examples/task1_allocations/task/标注任务分配.xlsx。
我目前只是把任务的id填写到了表格里，任务的Question_ID我并没有写进去。我现在需要你把这个表格优化一下，每个任务写成[id, Question_ID]的格式，并且同一个单元格里会进行换行处理。
优化以后的文件保存在工作目录下。
